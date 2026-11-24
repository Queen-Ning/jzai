import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Exercise the source used to build the first-party jz-devtools package.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { listTemplates, renderTemplate } = require('../../../../../app-packages/jz-devtools/backend/lib/templates');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { analyzeRequirement } = require('../../../../../app-packages/jz-devtools/backend/lib/analyze');

const appDir = path.resolve(__dirname, '../../../../../app-packages/jz-devtools');
const templateIds = [
  'panel-app',
  'tool-app',
  'full-app',
  'multi-tab-app',
  'async-job-app',
  'external-svc-app',
  'mcp-tool-app',
];

describe('jz-devtools scaffold rendering', () => {
  it('emits canonical Markdown pattern references', () => {
    const result = analyzeRequirement('分钟级批量排程求解');
    const refs = [...result.capabilities, ...result.warnings].map((entry: any) => entry.patternRef);
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.every((ref: string) => ref.endsWith('.md'))).toBe(true);
  });

  it('lists complete hyphenated template names', async () => {
    const templates = await listTemplates(appDir);
    expect(templates).toHaveLength(7);
    expect(templates.find((entry: any) => entry.id === 'external-svc-app')?.name).toBe('external-svc-app');
  });

  it.each(templateIds)('renders %s with safe identifiers and standalone build assets', async template => {
    const result = await renderTemplate(appDir, {
      template,
      appId: 'com.acme.sample',
      shortName: 'sample-app',
      nsPrefix: 'xy',
      name: '示例应用',
    });
    const manifest = JSON.parse(result.files['manifest.json']);
    const joined = Object.values(result.files).join('\n');

    expect(manifest.appId).toBe('com.acme.sample');
    expect(manifest.shortName).toBe('sample-app');
    expect(manifest.nsPrefix).toBe('xy');
    expect(manifest.name.zh).toBe('示例应用');
    if (manifest.database) expect(manifest.database.schemaName).toBe('app_sample_app');
    for (const permission of manifest.permissions ?? []) expect(permission.id).toMatch(/^xy:/);
    for (const provider of manifest.backend?.toolProviders ?? []) {
      for (const toolId of provider.toolIds) expect(toolId).toMatch(/^xy_/);
    }
    for (const panel of manifest.panels ?? []) {
      expect(panel.id).toMatch(/^xy[A-Z]/);
      if (panel.permission) expect(panel.permission).toMatch(/^xy:/);
    }
    for (const agent of manifest.agents ?? []) expect(result.files[agent.file]).toBeDefined();
    for (const skill of manifest.skills ?? []) expect(result.files[`${skill.dir}/SKILL.md`]).toBeDefined();
    for (const migration of manifest.migrations ?? []) {
      expect(result.files[migration.file.replace(/^\.\//, '')]).toBeDefined();
      if (migration.down) expect(result.files[migration.down.replace(/^\.\//, '')]).toBeDefined();
    }

    expect(result.files['build.mjs']).toContain("path.join(ROOT, 'sdk-lib')");
    // MC05：react-dom 也别名到 shim，共享宿主实例
    expect(result.files['build.mjs']).toContain("'react-dom': path.join(SDK_LIB, 'react-dom-shim.ts')");
    // 打包 CLI 只是入口；默认打包输入（含 manifest.json）在注入的 packager 库里
    expect(result.files['package-app.mjs']).toContain("from './packager/packager.mjs'");
    expect(result.files['packager/packager.mjs']).toContain("'manifest.json'");
    if (manifest.panels?.length) {
      for (const shim of ['react-shim.ts', 'react-dom-shim.ts', 'jsx-runtime-shim.ts']) {
        expect(result.files[`sdk-lib/${shim}`]).toBeDefined();
      }
    }
    expect(JSON.parse(result.files['package.json']).scripts).toEqual(expect.objectContaining({ build: expect.any(String), package: expect.any(String) }));
    expect(result.files['package-lock.json']).toContain('"@jianzhi/sample-app"');
    expect(result.templateVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(result.sdkVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(result.contentDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(joined).not.toContain('com.example.');
    expect(joined).not.toContain('xyModuleInterop');
    if (result.files['tsconfig.backend.json']) expect(result.files['tsconfig.backend.json']).toContain('esModuleInterop');
  });

  it.each(templateIds)('builds generated %s in a standalone project root', async template => {
    const result = await renderTemplate(appDir, {
      template,
      appId: 'com.acme.buildtest',
      shortName: 'build-test',
      nsPrefix: 'bt',
      name: '构建测试',
    });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `jz-scaffold-${template}-`));
    try {
      for (const [rel, content] of Object.entries(result.files) as Array<[string, string]>) {
        const target = path.join(root, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
      }
      fs.symlinkSync(
        path.resolve(appDir, 'sdk', 'node_modules'),
        path.join(root, 'node_modules'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      execFileSync(process.execPath, ['build.mjs'], { cwd: root, stdio: 'pipe', timeout: 30000 });
      const manifest = JSON.parse(result.files['manifest.json']);
      if (manifest.backend) expect(fs.existsSync(path.join(root, manifest.backend.entry))).toBe(true);
      for (const panel of manifest.panels ?? []) {
        if (panel.entryComponent) expect(fs.existsSync(path.join(root, panel.entryComponent))).toBe(true);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60000);
});
