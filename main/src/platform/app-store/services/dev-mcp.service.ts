import { Injectable, Logger, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { DbService } from '../../../db/db.service';
import { AppConfigService } from '../../../config/app-config.service';
import { AppRegistryService } from './app-registry.service';
import { AppAuditService } from './app-audit.service';
import { CredentialService } from '../../../capability/skill/credential.service';
import { ToolBridgeService } from '../../../agent/tool-bridge/tool-bridge.service';
import { DevUploadService } from './dev-upload.service';
import { createDevMcpPrincipal } from '../runtime/invocation-principal';
import { loadActiveUser, userPrincipalOf } from './active-user';
import { AppMcpExposeService, isFirstPartyApp } from './app-mcp-expose.service';
import { ResourceAccessService } from '../../authz/resource-access.service';
import { isAppUsable } from '../app-state';

export type DevTokenScope = 'read' | 'invoke' | 'manage';

interface StoredDevToken {
  tokenId: string;
  tokenHash: string; // sha256(token)，不可逆；原始 token 不落库
  issuedBy: string;
  scopes: DevTokenScope[];
  issuedAt: string;
  expiresAt?: string;
}

export interface VerifiedDevToken {
  tokenId: string;
  scopes: DevTokenScope[];
  /** 签发人用户 id（MC01：调用以该用户的身份与权限判定） */
  issuedBy: string;
}

// ── MC14：开发 MCP 提示（prompts/*.md） ──
const PROMPT_NAME = /^[a-z][a-z0-9_]{2,63}$/;
const PROMPT_ARGUMENT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const PROMPT_MAX_ARGUMENTS = 5;
const PROMPT_MAX_INCLUDES = 3;
export const PROMPT_ARGUMENT_MAX_CHARS = 2000;
export const PROMPT_INCLUDE_MAX_BYTES = 100 * 1024;

export interface PromptArgument {
  name: string;
  description: string;
  required: boolean;
}

interface LoadedPrompt {
  name: string;
  description: string;
  arguments: PromptArgument[];
  /** 相对应用安装目录的 docs/ 下路径 */
  include: string[];
  body: string;
  appId: string;
  root: string;
}

/**
 * 提示正文的文本替换（不做其他求值）：先处理 {{#参数}}…{{/参数}}（参数非空时保留内容，否则删除），
 * 再把 {{参数}} 换成参数值。只认 frontmatter 中声明的参数；参数值不会再被展开。
 */
export function renderPromptTemplate(body: string, values: ReadonlyMap<string, string>): string {
  const sections = body.replace(/\{\{#([A-Za-z][A-Za-z0-9_]*)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (whole, name: string, inner: string) => {
    if (!values.has(name)) return whole;
    return values.get(name)!.trim() ? inner : '';
  });
  return sections.replace(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g, (whole, name: string) => (values.has(name) ? values.get(name)! : whole));
}

const DEV_TOKEN_SCOPE = 'dev-mcp';
const DEFAULT_DEV_TOKEN_SCOPES: DevTokenScope[] = ['read', 'invoke', 'manage'];

/**
 * 框架内置 MCP 工具（不依赖首方包 mcpExposed）。
 * 大包上传编排：begin 预留句柄 → 客户端 multipart 直推 /api/dev/uploads → status 感知状态
 * → 把 uploadId 传给 jd_install_app/jd_upgrade_app/jd_validate_package（jz-devtools 双模工具）。
 */
const BUILTIN_TOOLS: Array<{ name: string; description: string; inputSchema: unknown }> = [
  {
    name: 'jd_upload_begin',
    description:
      '大包上传第一步（包 >1MB 时必须走本通道，否则 JSON body 超 1mb 限制）：预留上传句柄，返回 {uploadId, uploadUrl, expiresAt}。' +
      '随后用 HTTP multipart（字段名 package，Authorization: Bearer <dev-token>）把 .jzapp 直推 uploadUrl；' +
      '再调 jd_upload_status 确认 ready；最后把 uploadId 传给 jd_install_app/jd_upgrade_app/jd_validate_package 执行。' +
      '句柄 30 分钟过期、一次性使用。小包仍可走 files 内联。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'jd_upload_status',
    description:
      '查询上传句柄状态：pending（等待文件）/ready（可执行）/consumed（已执行）/expired（已过期）。' +
      '返回 {uploadId, status, size, sha256, createdAt, expiresAt}。',
    inputSchema: {
      type: 'object',
      properties: { uploadId: { type: 'string', description: 'jd_upload_begin 返回的句柄 id' } },
      required: ['uploadId'],
    },
  },
];

/**
 * Dev MCP（/api/dev/mcp）的支撑服务：
 * - dev token 签发/校验/吊销（jz_credentials scope=dev-mcp，AES-256-GCM）
 * - mcpExposed 工具聚合（仅首方包可声明，validator 已门控）
 * - resources（jzdev://docs/*、jzdev://templates/*，来自首方包安装目录）
 *
 * 多实例约束：与 v4 §1.4-A 一致——本端点依赖进程内注册表，仅支持单实例部署
 * （当前 docker-compose 恒为单 main 实例；多实例形态下不要开启 devMcp.enabled）。
 */
@Injectable()
export class DevMcpService {
  private readonly logger = new Logger(DevMcpService.name);

  constructor(
    private readonly db: DbService,
    private readonly config: AppConfigService,
    private readonly registry: AppRegistryService,
    private readonly audit: AppAuditService,
    private readonly credentials: CredentialService,
    private readonly moduleRef: ModuleRef,
    private readonly uploads: DevUploadService,
    // P3：审批门控（isAllowed）+ P1 grants 双保险（canView）；未接线时保持旧行为
    @Optional() private readonly expose?: AppMcpExposeService,
    @Optional() private readonly access?: ResourceAccessService,
  ) {}

  isEnabled(): boolean {
    return this.config.get<boolean>('devMcp.enabled', false) === true;
  }

  // ── dev token ──

  /**
   * 签发 dev token。token 仅本次返回；库中只保存 sha256 哈希与 tokenId/scope/签发元数据。
   * scopes 缺省为全量（read/invoke/manage），管理员可按最小授权收窄。
   */
  async issueToken(issuedBy: string, scopes?: DevTokenScope[]): Promise<{ token: string; tokenId: string }> {
    const token = `jzdev_${crypto.randomBytes(24).toString('hex')}`;
    const tokenId = `dtok_${crypto.randomBytes(4).toString('hex')}`;
    const payload: StoredDevToken = {
      tokenId,
      tokenHash: this.hashToken(token),
      issuedBy,
      scopes: scopes?.length ? scopes : DEFAULT_DEV_TOKEN_SCOPES,
      issuedAt: new Date().toISOString(),
    };
    await this.db.query(
      `INSERT INTO jz_credentials (scope, key, value_enc) VALUES ($1, $2, $3)
       ON CONFLICT (scope, key) DO UPDATE SET value_enc=$3, updated_at=NOW()`,
      [DEV_TOKEN_SCOPE, tokenId, this.credentials.encrypt(JSON.stringify(payload))],
    );
    await this.audit.log('dev-mcp', 'dev_token_issue', issuedBy, { tokenId, scopes: payload.scopes });
    return { token, tokenId };
  }

  async getTokenStatus(): Promise<{
    issued: boolean;
    tokens: Array<{ tokenId: string; issuedBy: string; scopes: DevTokenScope[]; issuedAt: string; expiresAt?: string }>;
  }> {
    const stored = await this.readStoredTokens();
    return {
      issued: stored.length > 0,
      tokens: stored.map(({ tokenId, issuedBy, scopes, issuedAt, expiresAt }) => ({
        tokenId, issuedBy, scopes, issuedAt, expiresAt,
      })),
    };
  }

  /** 吊销单个 token；tokenId 缺省时吊销全部。 */
  async revokeToken(actorId: string, tokenId?: string): Promise<void> {
    if (tokenId) {
      await this.db.query(`DELETE FROM jz_credentials WHERE scope=$1 AND key=$2`, [DEV_TOKEN_SCOPE, tokenId]);
    } else {
      await this.db.query(`DELETE FROM jz_credentials WHERE scope=$1`, [DEV_TOKEN_SCOPE]);
    }
    await this.audit.log('dev-mcp', 'dev_token_revoke', actorId, tokenId ? { tokenId } : { all: true });
  }

  /** 校验 token，成功返回稳定 tokenId、scope 与签发人；失败/过期返回 null。 */
  async verifyToken(token: string | undefined): Promise<VerifiedDevToken | null> {
    if (!token) return null;
    const hash = Buffer.from(this.hashToken(token));
    for (const stored of await this.readStoredTokens()) {
      const b = Buffer.from(stored.tokenHash);
      if (hash.length === b.length && crypto.timingSafeEqual(hash, b)) {
        if (stored.expiresAt && Date.parse(stored.expiresAt) <= Date.now()) return null;
        return { tokenId: stored.tokenId, scopes: stored.scopes, issuedBy: stored.issuedBy };
      }
    }
    return null;
  }

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  private async readStoredTokens(): Promise<StoredDevToken[]> {
    const res = await this.db.query(
      `SELECT value_enc FROM jz_credentials WHERE scope=$1`,
      [DEV_TOKEN_SCOPE],
    );
    const out: StoredDevToken[] = [];
    for (const row of res.rows) {
      try {
        const parsed = JSON.parse(this.credentials.decrypt(row.value_enc));
        if (parsed?.tokenId && parsed?.tokenHash) out.push(parsed);
      } catch {
        // 单条损坏不影响其余 token
      }
    }
    return out;
  }

  // ── tools（mcpExposed 聚合）──

  private async getExposedToolIds(): Promise<Set<string>> {
    const apps = await this.registry.findAll();
    const ids = new Set<string>();
    // MC11：只读期内的应用照常暴露工具（写入由应用自行拒绝），只读期满后才隐藏
    const now = Date.now();
    for (const app of apps.filter(a => isAppUsable(a, now))) {
      // P3：三方包 mcpExposed 须审批后生效（首方恒通）
      if (this.expose && !(await this.expose.isAllowed(app.appId))) continue;
      for (const tp of app.manifest?.backend?.toolProviders ?? []) {
        if (tp.mcpExposed) for (const t of tp.toolIds ?? []) ids.add(t);
      }
    }
    return ids;
  }

  async listTools(): Promise<Array<{ name: string; description: string; inputSchema: unknown }>> {
    const exposed = await this.getExposedToolIds();
    const bridge = this.moduleRef.get(ToolBridgeService, { strict: false });
    const exposedTools = exposed.size === 0 ? [] : bridge.getCatalog()
      .filter((e: any) => exposed.has(e.id))
      .map((e: any) => ({
        name: e.id,
        description: e.description ?? e.label ?? '',
        inputSchema: e.parameters ?? { type: 'object', properties: {} },
      }));
    return [...BUILTIN_TOOLS, ...exposedTools];
  }

  /**
   * 调用工具。actorId 是审计用的稳定主体（dev-mcp:<tokenId>）；issuedBy 是令牌签发人的用户 id（MC01）。
   * 内置上传工具不做授权检查；暴露工具以签发人的用户身份判定，并把该身份带给工具。
   */
  async callTool(name: string, args: unknown, actorId: string, issuedBy?: string): Promise<unknown> {
    const builtin = BUILTIN_TOOLS.find(t => t.name === name);
    if (builtin) {
      const result = this.callBuiltinTool(name, args ?? {});
      await this.audit.log('dev-mcp', 'dev_mcp_call', actorId, { tool: name, issuedBy });
      return result;
    }
    const exposed = await this.getExposedToolIds();
    if (!exposed.has(name)) throw new Error(`Tool not exposed via dev MCP: ${name}`);
    // 签发人不存在或已停用：令牌失效
    const user = issuedBy ? await this.principalForUser(issuedBy) : null;
    if (!user) throw new Error('Dev token issuer not found');
    // P3 双保险：grants 控"谁能调"（审批控"是否暴露"）。dev-mcp 主体在 canView 中属 system 直通，
    // 故以签发人的 user 主体判定。
    if (this.access && !(await this.access.canView('tool', name, user))) {
      throw new Error(`No tool grant for actor: ${name}`);
    }
    const bridge = this.moduleRef.get(ToolBridgeService, { strict: false });
    const result = await bridge.callTool(name, args, createDevMcpPrincipal(actorId, {
      userId: user.userId!,
      roleIds: user.roleIds,
      departmentIds: user.departmentIds,
      permissions: user.permissions,
    }));
    await this.audit.log('dev-mcp', 'dev_mcp_call', actorId, { tool: name, issuedBy });
    return result;
  }

  /**
   * 以用户的真实身份（role/department/permissions）构造 canView 判定主体。
   * 入参必须是用户 id；用户不存在或 status = 'disabled' 时返回 null。
   */
  private async principalForUser(userId: string) {
    const user = await loadActiveUser(this.db, userId);
    return user ? userPrincipalOf(user, 'dev-mcp') : null;
  }

  private callBuiltinTool(name: string, args: any): unknown {
    switch (name) {
      case 'jd_upload_begin': {
        const record = this.uploads.begin();
        return {
          ...record,
          uploadUrl: '/api/dev/uploads',
          hint: `curl -X POST <instance>/api/dev/uploads -H "Authorization: Bearer <dev-token>" -F "package=@<your-app>.jzapp" -F "uploadId=${record.uploadId}"`,
        };
      }
      case 'jd_upload_status':
        if (!args?.uploadId) throw new Error('uploadId is required');
        return this.uploads.get(args.uploadId);
      default:
        throw new Error(`Unknown builtin tool: ${name}`);
    }
  }

  // ── resources（首方包 docs/ 与 templates/）──

  /** 提供资源与提示的应用：可用（已激活，或授权只读期内，MC11）、首方应用号且声明 appstore:manage，按安装顺序 */
  private async sourceApps(): Promise<Array<{ appId: string; root: string }>> {
    const apps = await this.registry.findAll();
    const now = Date.now();
    // MC10：首方判定同时看应用号（io.jzai.*）与 appstore:manage，旧号首方包不再提供资源
    return apps
      .filter(a => isAppUsable(a, now) && a.installDir && isFirstPartyApp(a.manifest))
      .map(a => ({ appId: a.appId, root: a.installDir! }));
  }

  private async resourceRoots(): Promise<string[]> {
    return (await this.sourceApps()).map(a => a.root);
  }

  // ── prompts（MC14：首方包 prompts/*.md，来源与资源相同）──

  async listPrompts(): Promise<Array<{ name: string; description: string; arguments: PromptArgument[] }>> {
    return (await this.promptFiles()).map(p => ({ name: p.name, description: p.description, arguments: p.arguments }));
  }

  /**
   * 取得一个提示：校验参数，做 {{参数}} 与 {{#参数}}…{{/参数}} 文本替换，再在末尾依次附上 include 文件（调用时读取，不缓存）。
   * 审计只记提示名称、来源应用与签发人，不记参数值。
   */
  async getPrompt(
    name: unknown, args: unknown, actorId: string, issuedBy?: string,
  ): Promise<{ description: string; messages: Array<{ role: 'user'; content: { type: 'text'; text: string } }> }> {
    if (typeof name !== 'string' || !name) throw new Error('Prompt name is required');
    const prompt = (await this.promptFiles()).find(p => p.name === name);
    if (!prompt) throw new Error(`Prompt not found: ${name}`);

    const given = args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
    const values = new Map<string, string>();
    for (const arg of prompt.arguments) {
      const raw = given[arg.name];
      if (raw !== undefined && raw !== null && typeof raw !== 'string') {
        throw new Error(`Argument ${arg.name} must be a string`);
      }
      const value = typeof raw === 'string' ? raw : '';
      if (value.length > PROMPT_ARGUMENT_MAX_CHARS) {
        throw new Error(`Argument ${arg.name} exceeds ${PROMPT_ARGUMENT_MAX_CHARS} characters`);
      }
      if (arg.required && !value.trim()) throw new Error(`Missing required argument: ${arg.name}`);
      values.set(arg.name, value);
    }

    let text = renderPromptTemplate(prompt.body, values);
    for (const include of prompt.include) {
      const file = path.join(prompt.root, include);
      text += `\n\n---\n（附：${include}）\n\n${fs.readFileSync(file, 'utf-8')}`;
    }
    await this.audit.log('dev-mcp', 'dev_mcp_prompt_get', actorId, { prompt: name, appId: prompt.appId, issuedBy });
    return { description: prompt.description, messages: [{ role: 'user', content: { type: 'text', text } }] };
  }

  /** 每次调用时重新读取：已激活首方包的 prompts/*.md（不递归）；不合法的跳过并告警，同名先到先得 */
  private async promptFiles(): Promise<LoadedPrompt[]> {
    const out: LoadedPrompt[] = [];
    const seen = new Map<string, string>();
    for (const { appId, root } of await this.sourceApps()) {
      const dir = path.join(root, 'prompts');
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
      const files = fs.readdirSync(dir, { withFileTypes: true })
        .filter(e => e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('.'))
        .map(e => e.name)
        .sort();
      for (const fileName of files) {
        const where = `${appId}/prompts/${fileName}`;
        const parsed = this.parsePromptFile(root, path.join(dir, fileName), where);
        if (!parsed) continue;
        const first = seen.get(parsed.name);
        if (first) {
          this.warnOnce(`prompt ${parsed.name} in ${where} ignored: same name already provided by ${first}`);
          continue;
        }
        seen.set(parsed.name, where);
        out.push({ ...parsed, appId, root });
      }
    }
    return out;
  }

  private parsePromptFile(root: string, file: string, where: string): Omit<LoadedPrompt, 'appId' | 'root'> | null {
    const skip = (reason: string) => { this.warnOnce(`prompt ${where} skipped: ${reason}`); return null; };
    const match = fs.readFileSync(file, 'utf-8').match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/);
    if (!match) return skip('missing frontmatter');
    let meta: any;
    try {
      meta = yaml.load(match[1]);
    } catch (err: any) {
      return skip(`invalid frontmatter: ${err?.message ?? err}`);
    }
    if (!meta || typeof meta !== 'object') return skip('invalid frontmatter');
    if (typeof meta.name !== 'string' || !PROMPT_NAME.test(meta.name)) {
      return skip(`name must match ${PROMPT_NAME.source}`);
    }
    if (typeof meta.description !== 'string' || !meta.description.trim()) return skip('description is required');

    const rawArgs = meta.arguments ?? [];
    if (!Array.isArray(rawArgs) || rawArgs.length > PROMPT_MAX_ARGUMENTS) {
      return skip(`arguments must be a list of at most ${PROMPT_MAX_ARGUMENTS} items`);
    }
    const args: PromptArgument[] = [];
    for (const a of rawArgs) {
      if (!a || typeof a !== 'object' || typeof a.name !== 'string' || !PROMPT_ARGUMENT_NAME.test(a.name)) {
        return skip(`argument name must match ${PROMPT_ARGUMENT_NAME.source}`);
      }
      if (typeof a.description !== 'string' || !a.description.trim()) return skip(`argument ${a.name} needs a description`);
      if (a.required !== undefined && typeof a.required !== 'boolean') return skip(`argument ${a.name}: required must be true or false`);
      if (args.some(x => x.name === a.name)) return skip(`argument ${a.name} declared twice`);
      args.push({ name: a.name, description: a.description, required: a.required === true });
    }

    const include = this.resolveIncludes(root, meta.include);
    if (typeof include === 'string') return skip(include);
    return { name: meta.name, description: meta.description, arguments: args, include, body: match[2] };
  }

  /**
   * include（至多 3 个）：相对同一应用安装目录、位于 docs/ 下的 .md 文件，合计不超过 100KB。
   * 返回规范化的相对路径列表，不合法时返回原因（该提示整体跳过）。
   */
  private resolveIncludes(root: string, include: unknown): string[] | string {
    if (include === undefined || include === null) return [];
    if (!Array.isArray(include) || include.length > PROMPT_MAX_INCLUDES) {
      return `include must be a list of at most ${PROMPT_MAX_INCLUDES} paths`;
    }
    const docs = path.resolve(root, 'docs');
    const out: string[] = [];
    let total = 0;
    for (const item of include) {
      if (typeof item !== 'string' || !item) return 'include entries must be strings';
      const parts = item.split(/[\\/]+/);
      if (path.isAbsolute(item) || /^[a-zA-Z]:/.test(item) || parts.includes('..')) return `include ${item} must be a relative path without ..`;
      if (parts[0] !== 'docs' || !item.endsWith('.md')) return `include ${item} must be a .md file under docs/`;
      const target = path.resolve(root, item);
      if (!target.startsWith(docs + path.sep)) return `include ${item} must be a .md file under docs/`;
      let real: string;
      try {
        real = fs.realpathSync(target);
      } catch {
        return `include ${item} not found in this app`;
      }
      // 符号链接也不能指出本应用的 docs/
      if (!real.startsWith(fs.realpathSync(docs) + path.sep) || !fs.statSync(real).isFile()) {
        return `include ${item} must be a file inside this app's docs/`;
      }
      total += fs.statSync(real).size;
      if (total > PROMPT_INCLUDE_MAX_BYTES) return `include files exceed ${PROMPT_INCLUDE_MAX_BYTES / 1024}KB in total`;
      out.push(parts.join('/'));
    }
    return out;
  }

  /** 列表每次都会重新解析：同一条告警只记一次，避免刷屏 */
  private readonly warned = new Set<string>();
  private warnOnce(message: string): void {
    if (this.warned.has(message)) return;
    this.warned.add(message);
    this.logger.warn(message);
  }

  async listResources(): Promise<Array<{ uri: string; name: string; mimeType: string }>> {
    const out: Array<{ uri: string; name: string; mimeType: string }> = [];
    for (const root of await this.resourceRoots()) {
      for (const [scope, prefix] of [['docs', 'jzdev://docs/'], ['templates', 'jzdev://templates/']] as const) {
        const dir = path.join(root, scope);
        for (const file of this.walk(dir)) {
          out.push({
            uri: prefix + path.relative(dir, file).split(path.sep).join('/'),
            name: path.basename(file),
            mimeType: file.endsWith('.json') ? 'application/json' : 'text/markdown',
          });
        }
      }
    }
    return out;
  }

  async readResource(uri: string): Promise<{ uri: string; mimeType: string; text: string }> {
    const match = uri.match(/^jzdev:\/\/(docs|templates)\/(.+)$/);
    if (!match) throw new Error(`Unsupported resource uri: ${uri}`);
    const [, scope, rel] = match;
    if (path.isAbsolute(rel) || rel.split(/[\\/]+/).includes('..')) throw new Error('Path traversal rejected');
    const candidates = path.extname(rel) ? [rel] : [rel, `${rel}.md`];
    for (const root of await this.resourceRoots()) {
      const base = path.resolve(root, scope);
      for (const candidate of candidates) {
        const target = path.resolve(base, candidate);
        if (target.startsWith(base + path.sep) && fs.existsSync(target) && fs.statSync(target).isFile()) {
          return {
            uri: `jzdev://${scope}/${candidate.split(path.sep).join('/')}`,
            mimeType: target.endsWith('.json') ? 'application/json' : 'text/markdown',
            text: fs.readFileSync(target, 'utf-8'),
          };
        }
      }
    }
    throw new Error(`Resource not found: ${uri}`);
  }

  private walk(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...this.walk(full));
      else if (entry.isFile() && !entry.name.startsWith('.')) out.push(full);
    }
    return out;
  }
}
