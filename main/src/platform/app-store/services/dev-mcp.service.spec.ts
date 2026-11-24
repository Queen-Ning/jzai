import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DevMcpService, renderPromptTemplate } from './dev-mcp.service';
import { AppAuditService } from './app-audit.service';

function createTokenService() {
  const rows = new Map<string, string>(); // key -> value_enc (plain JSON via passthrough crypto)
  const db = {
    query: jest.fn(async (sql: string, params: any[]) => {
      if (sql.startsWith('INSERT INTO jz_credentials')) {
        rows.set(params[1], params[2]);
        return { rows: [] };
      }
      if (sql.startsWith('DELETE FROM jz_credentials WHERE scope=$1 AND key=$2')) {
        rows.delete(params[1]);
        return { rows: [] };
      }
      if (sql.startsWith('DELETE FROM jz_credentials WHERE scope=$1')) {
        rows.clear();
        return { rows: [] };
      }
      if (sql.startsWith('SELECT value_enc FROM jz_credentials')) {
        return { rows: [...rows.values()].map(v => ({ value_enc: v })) };
      }
      throw new Error(`unexpected sql: ${sql}`);
    }),
  };
  const credentials = {
    encrypt: (v: string) => v,
    decrypt: (v: string) => v,
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const service = new DevMcpService(
    db as any,
    {} as any,
    { findAll: jest.fn().mockResolvedValue([]) } as any,
    audit as any,
    credentials as any,
    {} as any,
    {} as any,
  );
  return { service, db, audit, rows };
}

describe('DevMcpService dev token', () => {
  it('issues token with stable tokenId and never stores the raw token', async () => {
    const { service, rows } = createTokenService();
    const { token, tokenId } = await service.issueToken('admin-1');
    expect(token).toMatch(/^jzdev_[0-9a-f]{48}$/);
    expect(tokenId).toMatch(/^dtok_[0-9a-f]{8}$/);
    for (const stored of rows.values()) {
      expect(stored).not.toContain(token);
    }
  });

  // T-P-01-C01：校验结果带签发人
  it('verifies token to tokenId/scopes/issuedBy and rejects unknown token', async () => {
    const { service } = createTokenService();
    const { token, tokenId } = await service.issueToken('admin-1', ['read']);
    const verified = await service.verifyToken(token);
    expect(verified).toEqual({ tokenId, scopes: ['read'], issuedBy: 'admin-1' });
    await expect(service.verifyToken('jzdev_' + '0'.repeat(48))).resolves.toBeNull();
    await expect(service.verifyToken(undefined)).resolves.toBeNull();
  });

  it('supports multiple tokens and revokes by tokenId only', async () => {
    const { service } = createTokenService();
    const a = await service.issueToken('admin-1');
    const b = await service.issueToken('admin-1');
    await service.revokeToken('admin-1', a.tokenId);
    await expect(service.verifyToken(a.token)).resolves.toBeNull();
    await expect(service.verifyToken(b.token)).resolves.toEqual({
      tokenId: b.tokenId,
      scopes: ['read', 'invoke', 'manage'],
      issuedBy: 'admin-1',
    });
    const status = await service.getTokenStatus();
    expect(status.tokens.map(t => t.tokenId)).toEqual([b.tokenId]);
  });

  it('revokes all tokens when tokenId omitted', async () => {
    const { service } = createTokenService();
    const a = await service.issueToken('admin-1');
    await service.issueToken('admin-1');
    await service.revokeToken('admin-1');
    await expect(service.verifyToken(a.token)).resolves.toBeNull();
    expect((await service.getTokenStatus()).issued).toBe(false);
  });

  it('audits issuance with tokenId and scopes', async () => {
    const { service, audit } = createTokenService();
    const { tokenId } = await service.issueToken('admin-1', ['read', 'invoke']);
    expect(audit.log).toHaveBeenCalledWith('dev-mcp', 'dev_token_issue', 'admin-1', {
      tokenId,
      scopes: ['read', 'invoke'],
    });
  });
});

describe('AppAuditService redaction', () => {
  it('redacts sensitive keys and raw dev tokens in payload', async () => {
    const queries: Array<[string, any[]]> = [];
    const db = {
      query: jest.fn(async (sql: string, params: any[]) => {
        queries.push([sql, params]);
        return { rows: [] };
      }),
    };
    const audit = new AppAuditService(db as any);
    const rawToken = `jzdev_${'a'.repeat(48)}`;
    await audit.log('app', 'dev_mcp_call', 'dev-mcp:dtok_1234abcd', {
      tokenId: 'dtok_1234abcd',
      nested: { apiKey: 'k', password: 'p', authorization: 'Bearer x', token: rawToken },
      list: [rawToken, 'plain'],
    });
    const detail = JSON.parse(queries[0][1][3]);
    expect(detail.tokenId).toBe('dtok_1234abcd');
    expect(detail.nested).toEqual({
      apiKey: '[redacted]',
      password: '[redacted]',
      authorization: '[redacted]',
      token: '[redacted]',
    });
    expect(detail.list).toEqual(['[redacted]', 'plain']);
    expect(JSON.stringify(detail)).not.toContain(rawToken);
  });
});

describe('DevMcpService resources', () => {
  let root: string;
  let service: DevMcpService;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-mcp-resource-'));
    fs.mkdirSync(path.join(root, 'docs', 'patterns'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs', 'patterns', 'async-job.md'), '# async job');
    service = new DevMcpService(
      {} as any,
      {} as any,
      { findAll: jest.fn().mockResolvedValue([{ status: 'active', installDir: root, manifest: { appId: 'io.jzai.jz-devtools', platformCapabilities: ['appstore:manage'] } }]) } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('lists and reads canonical Markdown resource URIs', async () => {
    const resources = await service.listResources();
    expect(resources).toContainEqual(expect.objectContaining({ uri: 'jzdev://docs/patterns/async-job.md' }));
    await expect(service.readResource('jzdev://docs/patterns/async-job.md')).resolves.toEqual(
      expect.objectContaining({ uri: 'jzdev://docs/patterns/async-job.md', text: '# async job' }),
    );
  });

  it('keeps extensionless resource references backward compatible', async () => {
    await expect(service.readResource('jzdev://docs/patterns/async-job')).resolves.toEqual(
      expect.objectContaining({ uri: 'jzdev://docs/patterns/async-job.md', text: '# async job' }),
    );
  });
});

// ── T-P-21（MC14）：首方包 prompts/*.md ──

describe('DevMcpService prompts（MC14 / T-P-21）', () => {
  let base: string;
  const roots: Record<string, string> = {};

  const write = (app: string, rel: string, text: string) => {
    const file = path.join(roots[app], rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  const prompt = (meta: string, body: string) => `---\n${meta}\n---\n${body}`;

  const P_ONE = prompt([
    'name: p_one',
    'description: 第一个提示',
    'arguments:',
    '  - name: file',
    '    description: 说明书路径',
    '    required: true',
    '  - name: system',
    '    description: 系统名',
    'include:',
    '  - docs/a.md',
    '  - docs/sub/b.md',
  ].join('\n'), '处理 {{file}}{{#system}}（{{system}}）{{/system}}。\n');

  function setup(apps: Array<{ key: string; appId: string; status?: string; caps?: string[]; readonlyUntil?: string }>) {
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const registry = {
      findAll: jest.fn(async () => apps.map(a => ({
        appId: a.appId,
        status: a.status ?? 'active',
        licenseReadonlyUntil: a.readonlyUntil,
        installDir: roots[a.key],
        manifest: { appId: a.appId, platformCapabilities: a.caps ?? ['appstore:manage'] },
      }))),
    };
    const service = new DevMcpService({} as any, {} as any, registry as any, audit as any, {} as any, {} as any, {} as any);
    const warn = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
    return { service, audit, warn };
  }

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-mcp-prompts-'));
    for (const key of ['A', 'B', 'C', 'D']) {
      roots[key] = path.join(base, key);
      fs.mkdirSync(roots[key], { recursive: true });
    }
    write('A', 'prompts/p_one.md', P_ONE);
    write('A', 'docs/a.md', '# A 文档');
    write('A', 'docs/sub/b.md', '# B 文档');
  });

  afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

  // T-P-21-C02
  it('C02: lists only prompts of active first-party apps, with description and arguments', async () => {
    write('B', 'prompts/p_two.md', prompt('name: p_two\ndescription: 第三方', 'x'));
    write('C', 'prompts/p_three.md', prompt('name: p_three\ndescription: 未激活', 'x'));
    write('A', 'prompts/nested/p_deep.md', prompt('name: p_deep\ndescription: 子目录不读', 'x'));
    write('A', 'prompts/readme.txt', 'not a prompt');
    const { service } = setup([
      { key: 'A', appId: 'io.jzai.a' },
      { key: 'B', appId: 'com.acme.b' },
      { key: 'C', appId: 'io.jzai.c', status: 'failed' },
    ]);
    expect(await service.listPrompts()).toEqual([{
      name: 'p_one',
      description: '第一个提示',
      arguments: [
        { name: 'file', description: '说明书路径', required: true },
        { name: 'system', description: '系统名', required: false },
      ],
    }]);
    // 首方应用号但未声明 appstore:manage 同样不提供
    const noManage = setup([{ key: 'A', appId: 'io.jzai.a', caps: [] }]);
    expect(await noManage.service.listPrompts()).toEqual([]);
  });

  // T-P-18 补修（MC11）：授权只读期内照常提供提示与资源，只读期满后不再提供
  it('MC11: read-only apps keep prompts and resources; apps past the read-only period lose them', async () => {
    write('C', 'prompts/p_three.md', prompt('name: p_three\ndescription: 只读期', 'x'));
    write('C', 'docs/c.md', '# C 文档');
    write('D', 'prompts/p_four.md', prompt('name: p_four\ndescription: 只读期满', 'x'));
    write('D', 'docs/d.md', '# D 文档');
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const past = new Date(Date.now() - 1_000).toISOString();
    const { service } = setup([
      { key: 'C', appId: 'io.jzai.c', status: 'license_expired', readonlyUntil: future },
      { key: 'D', appId: 'io.jzai.d', status: 'license_expired', readonlyUntil: past },
    ]);
    expect((await service.listPrompts()).map(p => p.name)).toEqual(['p_three']);
    const uris = (await service.listResources()).map(r => r.uri);
    expect(uris).toContain('jzdev://docs/c.md');
    expect(uris).not.toContain('jzdev://docs/d.md');
  });

  // T-P-21-C03 与 C10（拼接部分）
  it('C03/C10: replaces {{file}}, drops the empty optional section and appends includes in order', async () => {
    const { service } = setup([{ key: 'A', appId: 'io.jzai.a' }]);
    const res = await service.getPrompt('p_one', { file: 'a.md' }, 'dev-mcp:dtok_1', 'admin-1');
    expect(res.description).toBe('第一个提示');
    expect(res.messages).toHaveLength(1);
    expect(res.messages[0].role).toBe('user');
    expect(res.messages[0].content.text).toBe(
      '处理 a.md。\n\n\n---\n（附：docs/a.md）\n\n# A 文档\n\n---\n（附：docs/sub/b.md）\n\n# B 文档',
    );
    const withSystem = await service.getPrompt('p_one', { file: 'a.md', system: 'ERP' }, 'dev-mcp:dtok_1');
    expect(withSystem.messages[0].content.text.startsWith('处理 a.md（ERP）。')).toBe(true);
  });

  it('reads include files at call time and does not expand placeholders inside argument values', async () => {
    const { service } = setup([{ key: 'A', appId: 'io.jzai.a' }]);
    write('A', 'docs/a.md', '# A 已更新');
    const res = await service.getPrompt('p_one', { file: '{{system}}', system: 'X' }, 'dev-mcp:dtok_1');
    expect(res.messages[0].content.text).toContain('处理 {{system}}（X）');
    expect(res.messages[0].content.text).toContain('# A 已更新');
  });

  // T-P-21-C04
  it('C04: missing required argument and an argument over 2000 characters are errors naming the argument', async () => {
    const { service, audit } = setup([{ key: 'A', appId: 'io.jzai.a' }]);
    await expect(service.getPrompt('p_one', {}, 'dev-mcp:dtok_1')).rejects.toThrow('Missing required argument: file');
    await expect(service.getPrompt('p_one', { file: '   ' }, 'dev-mcp:dtok_1')).rejects.toThrow('Missing required argument: file');
    await expect(service.getPrompt('p_one', { file: 'x'.repeat(2001) }, 'dev-mcp:dtok_1')).rejects.toThrow('Argument file exceeds 2000 characters');
    await expect(service.getPrompt('p_one', { file: 'a', system: 3 }, 'dev-mcp:dtok_1')).rejects.toThrow('Argument system must be a string');
    await expect(service.getPrompt('p_one', { file: 'x'.repeat(2000) }, 'dev-mcp:dtok_1')).resolves.toBeDefined();
    await expect(service.getPrompt('nope', {}, 'dev-mcp:dtok_1')).rejects.toThrow('Prompt not found: nope');
    expect(audit.log).toHaveBeenCalledTimes(1);
  });

  // T-P-21-C05
  it('C05: skips a file without description and a name with capitals; first prompt of a name wins; all with warnings', async () => {
    write('A', 'prompts/no_desc.md', prompt('name: p_nodesc', 'x'));
    write('A', 'prompts/upper.md', prompt('name: P_Upper\ndescription: 大写', 'x'));
    write('A', 'prompts/bad_yaml.md', prompt('name: [unclosed', 'x'));
    write('A', 'prompts/six_args.md', prompt(['name: p_six', 'description: 六个参数', 'arguments:',
      ...[1, 2, 3, 4, 5, 6].map(i => `  - name: a${i}\n    description: d${i}`)].join('\n'), 'x'));
    write('A', 'prompts/no_frontmatter.md', '# 没有 frontmatter');
    write('D', 'prompts/p_one.md', prompt('name: p_one\ndescription: 同名的第二个', 'x'));
    write('D', 'prompts/p_other.md', prompt('name: p_other\ndescription: 其他提示', 'x'));
    const { service, warn } = setup([{ key: 'A', appId: 'io.jzai.a' }, { key: 'D', appId: 'io.jzai.d' }]);
    const list = await service.listPrompts();
    expect(list.map(p => [p.name, p.description])).toEqual([['p_one', '第一个提示'], ['p_other', '其他提示']]);
    const messages = warn.mock.calls.map(c => String(c[0]));
    expect(messages).toEqual(expect.arrayContaining([
      expect.stringContaining('io.jzai.a/prompts/no_desc.md skipped: description is required'),
      expect.stringContaining('io.jzai.a/prompts/upper.md skipped: name must match'),
      expect.stringContaining('io.jzai.a/prompts/bad_yaml.md skipped: invalid frontmatter'),
      expect.stringContaining('io.jzai.a/prompts/six_args.md skipped: arguments must be a list of at most 5 items'),
      expect.stringContaining('io.jzai.a/prompts/no_frontmatter.md skipped: missing frontmatter'),
      expect.stringContaining('prompt p_one in io.jzai.d/prompts/p_one.md ignored: same name already provided by io.jzai.a/prompts/p_one.md'),
    ]));
    // 同一条告警只记一次
    const before = warn.mock.calls.length;
    await service.listPrompts();
    expect(warn.mock.calls.length).toBe(before);
  });

  // T-P-21-C10（限制部分）
  it('C10: skips prompts whose include escapes docs/, is not .md, exceeds 3 entries or 100KB in total', async () => {
    write('A', 'secret.md', 'secret');
    write('A', 'docs/big1.md', 'x'.repeat(60 * 1024));
    write('A', 'docs/big2.md', 'x'.repeat(60 * 1024));
    write('A', 'docs/c.md', 'c');
    write('A', 'docs/note.txt', 't');
    const inc = (name: string, items: string[]) =>
      write('A', `prompts/${name}.md`, prompt([`name: ${name}`, 'description: d', 'include:', ...items.map(i => `  - ${i}`)].join('\n'), 'x'));
    inc('p_parent', ['../secret.md']);
    inc('p_dotdot', ['docs/../secret.md']);
    inc('p_abs', [path.join(roots.A, 'docs', 'a.md')]);
    inc('p_root', ['secret.md']);
    inc('p_txt', ['docs/note.txt']);
    inc('p_four', ['docs/a.md', 'docs/sub/b.md', 'docs/c.md', 'docs/a.md']);
    inc('p_big', ['docs/big1.md', 'docs/big2.md']);
    inc('p_missing', ['docs/none.md']);
    const { service, warn } = setup([{ key: 'A', appId: 'io.jzai.a' }]);
    expect((await service.listPrompts()).map(p => p.name)).toEqual(['p_one']);
    const messages = warn.mock.calls.map(c => String(c[0])).join('\n');
    for (const name of ['p_parent', 'p_dotdot', 'p_abs', 'p_root', 'p_txt', 'p_four', 'p_big', 'p_missing']) {
      expect(messages).toContain(`io.jzai.a/prompts/${name}.md skipped`);
    }
    expect(messages).toContain('include files exceed 100KB in total');
  });

  it('rejects an include that is a symlink pointing outside the app docs/', async () => {
    write('A', 'outside.md', 'outside');
    fs.symlinkSync(path.join(roots.A, 'outside.md'), path.join(roots.A, 'docs', 'link.md'));
    write('A', 'prompts/p_link.md', prompt('name: p_link\ndescription: d\ninclude:\n  - docs/link.md', 'x'));
    const { service } = setup([{ key: 'A', appId: 'io.jzai.a' }]);
    expect((await service.listPrompts()).map(p => p.name)).toEqual(['p_one']);
  });

  // T-P-21-C11
  it('C11: include resolves only inside the same app (a file present only in another app does not count)', async () => {
    write('D', 'docs/x.md', '# 只在 D 中');
    write('A', 'prompts/p_cross.md', prompt('name: p_cross\ndescription: d\ninclude:\n  - docs/x.md', 'x'));
    const { service, warn } = setup([{ key: 'A', appId: 'io.jzai.a' }, { key: 'D', appId: 'io.jzai.d' }]);
    expect((await service.listPrompts()).map(p => p.name)).toEqual(['p_one']);
    expect(warn.mock.calls.map(c => String(c[0])).join('\n')).toContain('io.jzai.a/prompts/p_cross.md skipped: include docs/x.md not found in this app');
  });

  // T-P-21-C09
  it('C09: audits dev_mcp_prompt_get with the prompt name and no argument values', async () => {
    const { service, audit } = setup([{ key: 'A', appId: 'io.jzai.a' }]);
    await service.getPrompt('p_one', { file: 'secret-plan.md', system: 'ERP' }, 'dev-mcp:dtok_1', 'admin-1');
    expect(audit.log).toHaveBeenCalledWith('dev-mcp', 'dev_mcp_prompt_get', 'dev-mcp:dtok_1', {
      prompt: 'p_one', appId: 'io.jzai.a', issuedBy: 'admin-1',
    });
    expect(JSON.stringify(audit.log.mock.calls)).not.toContain('secret-plan');
    expect(JSON.stringify(audit.log.mock.calls)).not.toContain('ERP');
  });

  it('ships a valid es_requirements prompt in the suite design (51) that the parser accepts', async () => {
    const draft = path.join(__dirname, '../../../../../app-packages/jz-esuite/design/51-需求说明书技能/prompts/es_requirements.md');
    write('A', 'prompts/es_requirements.md', fs.readFileSync(draft, 'utf-8'));
    write('A', 'docs/esuite/skills/es-requirements/SKILL.md', '# 技能正文');
    const { service } = setup([{ key: 'A', appId: 'io.jzai.esuite' }]);
    const listed = (await service.listPrompts()).find(p => p.name === 'es_requirements');
    expect(listed?.arguments.map(a => [a.name, a.required])).toEqual([['goal', false], ['appCode', false], ['file', false]]);
    const res = await service.getPrompt('es_requirements', { goal: '起草订单系统的需求说明书' }, 'dev-mcp:dtok_1');
    const text = res.messages[0].content.text;
    expect(text).toContain('我的目的：起草订单系统的需求说明书。');
    expect(text).not.toContain('应用码：');
    expect(text).not.toContain('{{');
    expect(text.endsWith('（附：docs/esuite/skills/es-requirements/SKILL.md）\n\n# 技能正文')).toBe(true);
  });
});

describe('renderPromptTemplate（MC14）', () => {
  it('keeps unknown placeholders and supports several sections of the same argument', () => {
    const values = new Map([['a', 'x'], ['b', '']]);
    expect(renderPromptTemplate('{{a}}{{#a}}[{{a}}]{{/a}}{{#b}}[{{b}}]{{/b}}{{c}}{{#c}}k{{/c}}', values)).toBe('x[x]{{c}}{{#c}}k{{/c}}');
  });
});
