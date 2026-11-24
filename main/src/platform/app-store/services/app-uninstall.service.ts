import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { WorkspaceService } from '../../../workspace/workspace.service';
import { AppRegistryService } from './app-registry.service';
import { AppSchemaService } from './app-schema.service';
import { AppMigrationService } from './app-migration.service';
import { AppPoolService } from './app-pool.service';
import { AppActivationService } from './app-activation.service';
import { AppCapabilityService } from './app-capability.service';
import { AppCredentialService } from './app-credential.service';

@Injectable()
export class AppUninstallService {
  private readonly logger = new Logger(AppUninstallService.name);

  constructor(
    private readonly workspace: WorkspaceService,
    private readonly registry: AppRegistryService,
    private readonly schema: AppSchemaService,
    private readonly migrations: AppMigrationService,
    private readonly pools: AppPoolService,
    private readonly activation: AppActivationService,
    private readonly capabilities: AppCapabilityService,
    private readonly credentials: AppCredentialService,
  ) {}

  async uninstall(appId: string, opts: { purgeData?: boolean } = {}): Promise<void> {
    const record = await this.registry.findOne(appId);
    if (!record) throw new NotFoundException(`App ${appId} not found`);

    await this.registry.updateStatus(appId, 'uninstalling');

    try {
      // 1. Deactivate backend and unregister tools
      await this.activation.deactivateApp(appId, 'uninstall');

      // 2. Remove panels and configuration artifacts
      await this.activation.removePanels(appId);
      const artifactWarnings = record.manifest
        ? [
          ...this.activation.removeAgents(record.manifest),
          ...this.activation.removeSkills(record.manifest),
        ]
        : [];
      this.activation.reloadRegistries();

      // 2.5 Remove capability origin mapping (badges disappear regardless of purge)
      await this.capabilities.removeForApp(appId);

      // 2.6 MC07：删除应用写入的消息与待办投影（应用卸载后快捷动作无处回调）
      await this.removeInbox(appId);

      // 3. Destroy connection pool first (no new queries after this)
      if (this.pools.hasPool(appId)) {
        await this.pools.destroyPool(appId);
      }

      // 4. Optionally roll back all migrations (purge app DB objects)
      if (opts.purgeData && record.manifest?.database) {
        try {
          await this.migrations.dropAll(appId);
        } catch (err) {
          this.logger.warn(`Failed to drop migrations for ${appId}: ${err.message}`);
        }
        try {
          await this.schema.dropSchemaAndRole(record.manifest);
        } catch (err) {
          this.logger.warn(`Failed to drop schema for ${appId}: ${err.message}`);
        }
      }

      // 5. Delete install directory
      if (record.installDir && fs.existsSync(record.installDir)) {
        fs.rmSync(record.installDir, { recursive: true, force: true });
      }
      // 留空的 versions/ 与 <shortName>/ 一并删掉：全新安装要求应用根目录为空，
      // 否则同 shortName 的应用（如退役旧号后装新号，MC10）会被「目录已存在」拒绝
      if (record.installDir) {
        pruneEmptyVersionParents(record.installDir);
      }

      // 6. Preserve recovery metadata unless all app data was explicitly purged
      if (opts.purgeData) {
        // 彻底删除：连同 credential store 中的 APP secret 一并清除
        await this.credentials.deleteAllSecrets(appId);
        await this.registry.delete(appId);
      } else {
        await this.registry.updateStatus(appId, 'uninstalled');
      }
      if (artifactWarnings.length > 0) {
        this.logger.warn(`App ${appId} uninstalled with ${artifactWarnings.length} configuration artifact(s) remaining: ${artifactWarnings.join('; ')}`);
      } else {
        this.logger.log(`App ${appId} uninstalled`);
      }
    } catch (err) {
      await this.registry.updateStatus(appId, 'failed');
      throw err;
    }
  }

  /** InboxModule 依赖本模块：经全局容器惰性取得；没有消息与待办中心时跳过，清理失败只记警告 */
  private async removeInbox(appId: string): Promise<void> {
    try {
      const app = (global as any).nestApp;
      if (!app) return;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { InboxService } = require('../../inbox/inbox.service');
      const inbox = app.get(InboxService, { strict: false });
      if (inbox) await inbox.removeForApp(appId);
    } catch (err: any) {
      this.logger.warn(`Failed to remove inbox items for ${appId}: ${err?.message ?? err}`);
    }
  }
}

/**
 * 仅对版本目录协议（app-store/<shortName>/versions/<version>）生效：依次删除为空的
 * versions/ 与 <shortName>/。rmdir 只删空目录，非空（如还有其他版本或数据）即停。
 */
function pruneEmptyVersionParents(installDir: string): void {
  const versionsDir = path.dirname(installDir);
  if (path.basename(versionsDir) !== 'versions') return;
  for (const dir of [versionsDir, path.dirname(versionsDir)]) {
    try {
      fs.rmdirSync(dir);
    } catch {
      return;
    }
  }
}
