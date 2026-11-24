import { Injectable, Logger, Optional } from '@nestjs/common';
import { DbService } from '../../../db/db.service';
import { AppRegistryService, AppStatus } from './app-registry.service';
import { AppLicenseRuntimeService } from './app-license-runtime.service';
import { isAppLicenseExpired, verifyAppLicense } from '../../../edition/app-license';

export interface SetLicenseResult {
  /** 写入后的注册表状态 */
  status: AppStatus;
  /** 本次是否从 license_expired 恢复为 active */
  restored: boolean;
  expiresAt: string;
  /** 写入的 License 本身已过期（只落库，不恢复） */
  expired: boolean;
  /** 未能恢复的原因（如包完整性复查不通过） */
  reason?: string;
}

/**
 * APP 订阅 License 机制层（验签 + 落库 + 安装门控判定）。
 *
 * 解耦边界（设计方案 v1.1）：本服务只提供机制，不含授权审计策略——
 * 每日到期审计循环由闭源 app-store APP 驱动（其本地自验后经
 * facade setAppStatus 回写状态），避免审计被篡改的开源主台禁用。
 */
@Injectable()
export class AppLicenseService {
  private readonly logger = new Logger(AppLicenseService.name);
  private installationId: string | null = null;

  constructor(
    private readonly db: DbService,
    private readonly registry: AppRegistryService,
    // MC11：恢复为 active 时经它复查完整性并恢复运行；spec 直构不传时保持旧行为（只改注册表状态）
    @Optional() private readonly licenseRuntime?: AppLicenseRuntimeService,
  ) {}

  /** 本实例 installationId（与 edition.service 同一数据源） */
  private async getInstallationId(): Promise<string> {
    if (this.installationId) return this.installationId;
    const { rows } = await this.db.query(
      'SELECT id FROM jz_installation ORDER BY installation_token IS NOT NULL DESC, setup_phase DESC LIMIT 1',
    );
    const id = rows[0]?.id as string | undefined;
    if (!id) throw new Error('Local installation ID not initialized');
    this.installationId = id;
    return id;
  }

  /**
   * 写入/刷新 APP 的订阅 License（订阅拉取成功或管理员导入后调用）。
   * 验签通过才落库（无效时抛错，不改任何状态）；若 APP 当前处于 license_expired 且新 license 未过期，
   * 先复查包完整性再恢复 active 并恢复运行（MC11）；完整性不通过时 License 已写入但保持 license_expired。
   */
  async setLicense(appId: string, licenseBlob: string): Promise<SetLicenseResult> {
    const installationId = await this.getInstallationId();
    const payload = verifyAppLicense(licenseBlob, installationId, appId); // throws on invalid
    const expiresAt = new Date(payload.expiresAt * 1000);

    await this.registry.updateLicense(appId, licenseBlob, expiresAt);

    const app = await this.registry.findOne(appId);
    if (!app) throw new Error(`App ${appId} not found`);
    const expired = isAppLicenseExpired(payload);
    if (app.status !== 'license_expired' || expired) {
      return { status: app.status, restored: false, expiresAt: expiresAt.toISOString(), expired };
    }
    if (!this.licenseRuntime) {
      await this.registry.updateStatus(appId, 'active');
      this.logger.log(`App ${appId} license renewed — status restored to active`);
      return { status: 'active', restored: true, expiresAt: expiresAt.toISOString(), expired };
    }
    const result = await this.licenseRuntime.restore({ ...app, licenseBlob, licenseExpiresAt: expiresAt });
    if (result.restored) this.logger.log(`App ${appId} license renewed — restored to active`);
    return result.restored
      ? { status: 'active', restored: true, expiresAt: expiresAt.toISOString(), expired }
      : { status: 'license_expired', restored: false, expiresAt: expiresAt.toISOString(), expired, reason: result.reason };
  }

  /** 管理员导入前的检查：验签与绑定（错误时抛出原因），并要求未过期 */
  async verifyForImport(appId: string, licenseBlob: string): Promise<{ expiresAt: string }> {
    const installationId = await this.getInstallationId();
    const payload = verifyAppLicense(licenseBlob, installationId, appId); // throws on invalid
    if (isAppLicenseExpired(payload)) {
      throw new Error(`许可证已于 ${new Date(payload.expiresAt * 1000).toISOString()} 过期`);
    }
    return { expiresAt: new Date(payload.expiresAt * 1000).toISOString() };
  }

  /** 检查给定 license_blob 对本实例该 APP 是否有效且未过期（安装/升级门控用） */
  async hasValidLicense(appId: string, licenseBlob?: string | null): Promise<boolean> {
    if (!licenseBlob) return false;
    try {
      const installationId = await this.getInstallationId();
      const payload = verifyAppLicense(licenseBlob, installationId, appId);
      return !isAppLicenseExpired(payload);
    } catch {
      return false;
    }
  }
}
