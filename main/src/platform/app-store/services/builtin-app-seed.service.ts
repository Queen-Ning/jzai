import { Injectable, Logger, OnApplicationBootstrap, Optional } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DbService } from '../../../db/db.service';
import { RETIRED_FIRST_PARTY_APPS } from '../first-party';
import { AppAuditService } from './app-audit.service';
import { AppUninstallService } from './app-uninstall.service';
import { AppRegistryService } from './app-registry.service';
import { AppInstallService } from './app-install.service';
import { AppUpgradeService } from './app-upgrade.service';
import { SafeArchiveService } from './safe-archive.service';

/**
 * 内置官方 APP 预装/自升级（M7）。
 *
 * 扫 config/bundled-apps/*.jzapp（随 main 产物分发——Docker 镜像与原生
 * 安装包的 main 组件均包含 main/config）：
 * - 未安装 → 内部直调 AppInstallService（不经 HTTP，避免 admin token 鸡生蛋）
 * - 已装但 bundled 版本更高 → AppUpgradeService（官方 APP 自身升级通道）
 * - 失败仅记日志，下次启动重试，不阻塞平台启动
 */
@Injectable()
export class BuiltinAppSeedService implements OnApplicationBootstrap {
  private readonly logger = new Logger(BuiltinAppSeedService.name);

  constructor(
    private readonly registry: AppRegistryService,
    private readonly install: AppInstallService,
    private readonly upgrade: AppUpgradeService,
    private readonly archives: SafeArchiveService,
    // MC10：旧号首方应用退役（可选注入，单测直构时不接线则跳过退役）
    @Optional() private readonly uninstaller?: AppUninstallService,
    @Optional() private readonly db?: DbService,
    @Optional() private readonly audit?: AppAuditService,
  ) {}

  onApplicationBootstrap() {
    // 后台执行，不阻塞启动
    setImmediate(() => {
      void this.seed().catch(err => this.logger.warn(`内置 APP 预装失败: ${err.message}`));
    });
  }

  private bundledDir(): string {
    return process.env.BUNDLED_APPS_DIR || path.join(process.cwd(), 'config', 'bundled-apps');
  }

  async seed(): Promise<void> {
    // 必须在预装目录检查之前：没有预装目录的实例也要退役旧号（MC10）
    await this.retireLegacyApps();
    const dir = this.bundledDir();
    if (!fs.existsSync(dir)) return;
    const packages = fs.readdirSync(dir).filter(f => f.endsWith('.jzapp'));
    if (packages.length === 0) return;

    for (const file of packages) {
      const pkgPath = path.join(dir, file);
      try {
        await this.seedOne(pkgPath);
      } catch (err: any) {
        this.logger.warn(`内置 APP ${file} 预装/升级失败（下次启动重试）: ${err.message}`);
      }
    }
  }

  /**
   * 旧号首方应用退役（MC10）：对 RETIRED_FIRST_PARTY_APPS 中注册表里存在的每一项（任何状态，
   * 含 uninstalled 与上次失败留下的 failed），以 purgeData 卸载；再删除卸载流程不覆盖的残留
   * （资源授权、资源元数据、MCP 暴露审批），写审计。单项失败只记日志，下次启动重试。
   */
  async retireLegacyApps(): Promise<void> {
    if (!this.uninstaller) return;
    for (const appId of RETIRED_FIRST_PARTY_APPS) {
      try {
        const existing = await this.registry.findOne(appId);
        if (!existing) continue;
        this.logger.log(`退役旧号首方应用 ${appId}（状态 ${existing.status}）…`);
        await this.uninstaller.uninstall(appId, { purgeData: true });
        if (this.db) {
          // jz_app_grants 随注册表记录级联删除；jz_resource_grants 的镜像行没有外键，这里删
          await this.db.query(`DELETE FROM jz_resource_grants WHERE resource_type = 'app' AND resource_id = $1`, [appId]);
          await this.db.query(`DELETE FROM jz_resource_meta WHERE resource_type = 'app' AND resource_id = $1`, [appId]);
          await this.db.query(`DELETE FROM jz_app_mcp_expose WHERE app_id = $1`, [appId]);
        }
        await this.audit?.log(appId, 'retire_legacy_first_party', null, { previousStatus: existing.status });
        this.logger.log(`旧号首方应用 ${appId} 已退役`);
      } catch (err: any) {
        this.logger.warn(`旧号首方应用 ${appId} 退役失败（下次启动重试）: ${err.message}`);
      }
    }
  }

  private async seedOne(pkgPath: string): Promise<void> {
    const manifest = await this.peekManifest(pkgPath);
    const existing = await this.registry.findOne(manifest.appId);

    if (!existing || existing.status === 'uninstalled') {
      this.logger.log(`预装内置 APP ${manifest.appId}@${manifest.version}…`);
      await this.install.install(pkgPath);
      this.logger.log(`内置 APP ${manifest.appId}@${manifest.version} 预装完成`);
      return;
    }

    if (compareSemver(manifest.version, existing.version) > 0) {
      this.logger.log(`内置 APP ${manifest.appId} 检测到新版本 ${existing.version} → ${manifest.version}，自动升级…`);
      await this.upgrade.upgrade(manifest.appId, pkgPath);
      this.logger.log(`内置 APP ${manifest.appId} 升级完成`);
      return;
    }

    this.logger.debug(`内置 APP ${manifest.appId}@${existing.version} 已是最新，跳过`);
  }

  /** 解包到临时目录读取 manifest（不安装），用完即删 */
  private async peekManifest(pkgPath: string): Promise<{ appId: string; version: string }> {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jzbundled-'));
    try {
      await this.archives.extract(pkgPath, tmp);
      const manifest = JSON.parse(fs.readFileSync(path.join(tmp, 'manifest.json'), 'utf-8'));
      if (!manifest.appId || !manifest.version) throw new Error('manifest 缺少 appId/version');
      return { appId: manifest.appId, version: manifest.version };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
}

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(x => parseInt(x, 10) || 0);
  const pb = b.split('.').map(x => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
