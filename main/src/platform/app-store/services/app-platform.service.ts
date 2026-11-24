import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { AppManifest } from '../validators/manifest.schema';
import { AppRegistryService } from './app-registry.service';
import { AppLogService, AppLogEntry } from './app-log.service';
import { AppValidatorService } from '../validators/app-validator.service';
import { ToolBridgeService } from '../../../agent/tool-bridge/tool-bridge.service';
import { AppCapabilityService } from './app-capability.service';
import type { AppInstallService } from './app-install.service';
import type { AppUpgradeService } from './app-upgrade.service';
import type { AppUninstallService } from './app-uninstall.service';
import { AppStagingService } from './app-staging.service';
import { AppInstallOperationService } from './app-install-operation.service';
import { AppLicenseService } from './app-license.service';
import { AppLicenseRuntimeService } from './app-license-runtime.service';
import { DevUploadService } from './dev-upload.service';
import { SafeArchiveService } from './safe-archive.service';
import { DbService } from '../../../db/db.service';
import { createServicePrincipal } from '../runtime/invocation-principal';
import { RESERVED_NAMESPACE_LABEL, isFirstPartyAppId } from '../first-party';
import { HOSTED_BY_TAG_PREFIX } from '../app-state';
import { AppAuditService } from './app-audit.service';
import { AppGrantService } from './app-grant.service';
import { loadActiveUser, userPrincipalOf } from './active-user';
import { AppConfigService } from '../../../config/app-config.service';
import { TemporalNotEnabledError, resolveTemporalSettings } from '../../system/temporal-config';
import type {
  SandboxArtifact, SandboxArtifactInput, SandboxBridgeHandler, SandboxHealth, SandboxInvokeRequest, SandboxInvokeResult,
} from '../../sandbox/sandbox.types';

/** SandboxService 中门面用到的部分（类本身惰性 require，避免 sandbox → app-store 的文件级循环） */
interface SandboxServiceLike {
  isEnabled(): boolean;
  health(): SandboxHealth;
  prepareArtifact(hostAppId: string, input: SandboxArtifactInput): Promise<SandboxArtifact>;
  invoke(hostAppId: string, handle: string, request: SandboxInvokeRequest): Promise<SandboxInvokeResult>;
  disposeArtifact(hostAppId: string, handle: string): Promise<void>;
  disposeVersion(hostAppId: string, appId: string, version: string): Promise<{ disposed: number }>;
  listArtifacts(hostAppId: string, appId?: string): SandboxArtifact[];
  setBridgeHandler(hostAppId: string, handler: SandboxBridgeHandler | undefined): void;
}

/**
 * AppInstallService/AppUpgradeService 与 AppActivationService 存在构造期循环
 * （activation → app-platform → install → activation）。
 * 这两个类只能 import type + 调用时 lazy require，不可顶层 import 运行时值。
 */
function lazyInstall(): typeof AppInstallService {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('./app-install.service').AppInstallService;
}
function lazyUpgrade(): typeof AppUpgradeService {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('./app-upgrade.service').AppUpgradeService;
}
/** AppUninstallService 同样经 AppActivationService 依赖本文件（MC02 host.uninstallApp） */
function lazyUninstall(): typeof AppUninstallService {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('./app-uninstall.service').AppUninstallService;
}

/**
 * 首方运行时通道（design-app-dev-mcp §3.4 AppContext.platform）。
 * 仅注入给声明 appstore:*、platform:temporal 或 platform:sandbox 且通过首方校验的扩展包（jz-devtools、企业套件等）。
 * 跨模块服务经 ModuleRef 惰性解析，避免 DI 循环。
 */
export interface AppPlatformFacade {
  stageAndInstall?(
    files: Record<string, string>,
    config?: Record<string, unknown>,
  ): Promise<{ appId: string; status: string }>;
  upgrade?(appId: string, files: Record<string, string>): Promise<{ ok: true }>;
  validatePackage?(
    files: Record<string, string>,
  ): Promise<{ ok: boolean; issues: Array<{ code: string; path?: string; message: string; hint?: string }> }>;
  /** 大包通道（DevUploadService 句柄）：与 files 版等价，执行后句柄 consumed 并清理临时文件 */
  installFromUpload?(uploadId: string, config?: Record<string, unknown>): Promise<{ appId: string; status: string }>;
  upgradeFromUpload?(appId: string, uploadId: string): Promise<{ ok: true }>;
  validateFromUpload?(
    uploadId: string,
  ): Promise<{ ok: boolean; issues: Array<{ code: string; path?: string; message: string; hint?: string }> }>;
  listPlatformTools?(): Promise<Array<{ id: string; group?: string; description?: string; source: string }>>;
  describeTool?(toolId: string): Promise<unknown>;
  callTool?(toolId: string, params: unknown): Promise<unknown>;
  readLogs?(appId: string, since?: number): Promise<AppLogEntry[]>;
  /**
   * 官网商城中性原语（appstore:market）。
   * 安全模型：商城 HTTP、订阅判定、License 验签、包验签全部在调用方（闭源 APP）内完成；
   * 主台只提供本机凭据读取与安装/落库机制，这些原语无法帮助伪造授权——
   * token 签不出 license，setAppLicense 自身验签，安装链路强制包验签。
   */
  market?: {
    websiteUrl(): Promise<string>;
    installationToken(): Promise<string>;
    installationId(): Promise<string>;
    listInstalledApps(): Promise<Array<{
      appId: string; version: string; status: string;
      licenseBlob: string | null; licenseExpiresAt: string | null;
      /** MC11：只读期截止时间（ISO）；不在只读期为 null */
      licenseReadonlyUntil: string | null;
      installDir: string | null;
    }>>;
    /** 商城安装进度：创建 downloading 阶段的安装操作，面板凭 stageId 轮询 GET /stage/:stageId */
    beginInstallOperation(): Promise<{ stageId: string }>;
    /** 仅允许写 downloading 阶段进度（percent 截断到 0-45）；后续阶段由安装链路状态机驱动 */
    updateInstallProgress(stageId: string, percent: number, message: string): Promise<void>;
    failInstallOperation(stageId: string, message: string): Promise<void>;
    /** 挂到已有操作上的安装/升级：staging 校验→安装/升级全程进度写入该操作，终态 succeeded/failed */
    installPackageTracked(stageId: string, packagePath: string): Promise<{ appId: string }>;
    upgradePackageTracked(stageId: string, appId: string, packagePath: string): Promise<void>;
    setAppLicense(appId: string, licenseBlob: string): Promise<void>;
    /** 授权审计回写：仅限 'active' | 'license_expired'（其他状态由运行时状态机管理） */
    setAppStatus(appId: string, status: 'active' | 'license_expired'): Promise<void>;
  };
  /**
   * 托管宿主原语（appstore:host，MC02）。
   * 卸载只作用于 manifest.tags 含 `hosted-by:{调用方 appId}` 的应用；权限查询的目标为调用方自身或其托管的应用。
   * 每次调用写审计（app_id 为调用方）。
   */
  host?: {
    listHostedApps(): Promise<HostedAppInfo[]>;
    uninstallApp(appId: string, opts?: { purgeData?: boolean }): Promise<void>;
    /** 用户在目标应用中持有的权限 id（含 default 为 user 的权限；管理员返回全部）；用户不存在或已停用返回 [] */
    getAppPermissions(appId: string, userId: string): Promise<string[]>;
    /** 用户不存在或已停用返回 null */
    getUserProfile(userId: string): Promise<HostUserProfile | null>;
    /** 按授权记录展开的权限持有人（不看 default，管理员无显式授权不返回，排除停用用户），最多 500 人 */
    listPermissionHolders(
      appId: string, permissionId: string, opts?: { departmentIds?: string[] },
    ): Promise<PermissionHolders>;
    /**
     * 用户的上级（企业套件流程审批的升级，44 T-S3-09）：先取用户资料中的上级（jz_user_profiles.manager_id），
     * 没有时取所在部门的负责人（jz_departments.head_user_id 或成员角色 head，不含本人），本人就是负责人时取上级部门的负责人。
     * 只返回在用的用户；每次最多 100 个用户，查不到的为空数组。
     */
    listUserManagers(userIds: string[]): Promise<Record<string, string[]>>;
  };
  /**
   * Temporal 平台组件（platform:temporal，MC13）：只返回连接参数，主台不引用 Temporal SDK。
   * 每次调用都重新读取配置（system.json 修改后无需重启）。经独立进程 RPC 调用时同样返回 Promise。
   */
  temporal?: {
    /** 未启用时抛 TEMPORAL_NOT_ENABLED；命名空间为调用方 shortName */
    getConnectionOptions(): Promise<TemporalConnectionOptions>;
    isEnabled(): Promise<boolean>;
  };
  /**
   * 隔离插件运行平台（platform:sandbox，MC16）：托管应用的后端 WebAssembly 插件。
   * 只能管理 tags 含 `hosted-by:{调用方}` 的应用的制品；未启用时 prepare 与 invoke 抛 SANDBOX_NOT_ENABLED。
   * 经独立进程 RPC 调用时，onBridgeCall 的处理函数留在子进程，平台按需回调。
   */
  sandbox?: {
    isEnabled(): Promise<boolean>;
    health(): Promise<SandboxHealth>;
    prepareArtifact(input: SandboxArtifactInput): Promise<SandboxArtifact>;
    invoke(handle: string, request: SandboxInvokeRequest): Promise<SandboxInvokeResult>;
    disposeArtifact(handle: string): Promise<void>;
    disposeVersion(appId: string, version: string): Promise<{ disposed: number }>;
    listArtifacts(appId?: string): Promise<SandboxArtifact[]>;
    /** 注册能力桥处理函数（每个宿主一个，后注册的替换先注册的；传 null 取消） */
    onBridgeCall(handler: SandboxBridgeHandler | null): Promise<void>;
  };
}

export interface TemporalConnectionOptions {
  address: string;
  namespace: string;
}

// 定义移到无依赖的 app-state.ts（panel 的应用入口也要用，T-P-19），这里保留导出
export { HOSTED_BY_TAG_PREFIX };
export const PERMISSION_HOLDERS_LIMIT = 500;
export const USER_MANAGERS_LIMIT = 100;

export interface HostedAppInfo {
  appId: string;
  version: string;
  status: string;
  tags: string[];
}

export interface HostUserProfile {
  id: string;
  name: string;
  roleId: string | null;
  departmentIds: string[];
  permissions: string[];
}

export interface PermissionHolders {
  userIds: string[];
  /** 持有人超过 500 时为 true，userIds 只含前 500 个（按用户 id 排序） */
  truncated: boolean;
}


@Injectable()
export class AppPlatformService {
  private readonly logger = new Logger(AppPlatformService.name);

  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly registry: AppRegistryService,
    private readonly logs: AppLogService,
    private readonly capabilities: AppCapabilityService,
    private readonly db: DbService,
    private readonly staging: AppStagingService,
    private readonly operations: AppInstallOperationService,
    private readonly appLicenses: AppLicenseService,
    private readonly uploads: DevUploadService,
    private readonly archives: SafeArchiveService,
    // @Optional：spec 直构不传时只看环境变量（system.json 视为空）
    @Optional() private readonly appConfig?: AppConfigService,
  ) {}

  /**
   * 按 manifest 声明构建门控门面。
   * 非首方 appId / 未声明 appstore:* → undefined（普通包拿不到平台能力）。
   */
  buildFacade(manifest: AppManifest): AppPlatformFacade | undefined {
    if (!isFirstPartyAppId(manifest.appId)) return undefined;
    const caps = manifest.platformCapabilities ?? [];
    const facade: AppPlatformFacade = {};

    if (caps.includes('appstore:manage')) {
      facade.stageAndInstall = (files, config) => this.stageAndInstall(files, config);
      facade.upgrade = (appId, files) => this.upgradeApp(appId, files);
      facade.validatePackage = files => this.validatePackage(files);
      facade.installFromUpload = (uploadId, config) => this.installFromUpload(uploadId, config);
      facade.upgradeFromUpload = (appId, uploadId) => this.upgradeFromUpload(appId, uploadId);
      facade.validateFromUpload = uploadId => this.validateFromUpload(uploadId);
      facade.listPlatformTools = () => this.listPlatformTools();
      facade.describeTool = toolId => this.describeTool(toolId);
      const principal = createServicePrincipal(manifest.appId, 'app-platform', ['app:invoke']);
      facade.callTool = (toolId, params) =>
        this.moduleRef.get(ToolBridgeService, { strict: false }).callTool(toolId, params, principal);
    }
    if (caps.includes('appstore:read-logs')) {
      facade.readLogs = (appId, since) => Promise.resolve(this.logs.read(appId, since ?? 0));
    }
    if (caps.includes('appstore:market')) {
      facade.market = {
        websiteUrl: () => Promise.resolve(
          (process.env.JIANZHI_WEBSITE_URL || 'http://198.18.4.231').replace(/\/$/, ''),
        ),
        installationToken: () => this.getInstallationToken(),
        installationId: () => this.getInstallationId(),
        listInstalledApps: () => this.listInstalledApps(),
        beginInstallOperation: () => this.beginInstallOperation(),
        updateInstallProgress: (stageId, percent, message) =>
          this.updateInstallProgress(stageId, percent, message),
        failInstallOperation: (stageId, message) => this.failInstallOperation(stageId, message),
        installPackageTracked: (stageId, packagePath) =>
          this.installPackageTracked(stageId, packagePath),
        upgradePackageTracked: (stageId, appId, packagePath) =>
          this.upgradePackageTracked(stageId, appId, packagePath),
        setAppLicense: async (appId, licenseBlob) => { await this.appLicenses.setLicense(appId, licenseBlob); },
        setAppStatus: (appId, status) => this.setAppStatus(appId, status),
      };
    }
    if (caps.includes('appstore:host')) {
      const caller = manifest.appId;
      facade.host = {
        listHostedApps: () => this.listHostedApps(caller),
        uninstallApp: (appId, opts) => this.uninstallHostedApp(caller, appId, opts),
        getAppPermissions: (appId, userId) => this.getAppPermissions(caller, appId, userId),
        getUserProfile: userId => this.getUserProfile(caller, userId),
        listPermissionHolders: (appId, permissionId, opts) =>
          this.listPermissionHolders(caller, appId, permissionId, opts),
        listUserManagers: userIds => this.listUserManagers(caller, userIds),
      };
    }
    if (caps.includes('platform:temporal')) {
      const namespace = manifest.shortName;
      facade.temporal = {
        getConnectionOptions: async () => {
          const settings = this.temporalSettings();
          if (!settings.enabled) throw new TemporalNotEnabledError();
          return { address: settings.address, namespace };
        },
        isEnabled: async () => this.temporalSettings().enabled,
      };
    }
    if (caps.includes('platform:sandbox')) {
      const caller = manifest.appId;
      const svc = () => this.sandboxService();
      facade.sandbox = {
        isEnabled: async () => svc().isEnabled(),
        health: async () => svc().health(),
        prepareArtifact: input => svc().prepareArtifact(caller, input),
        invoke: (handle, request) => svc().invoke(caller, handle, request),
        disposeArtifact: handle => svc().disposeArtifact(caller, handle),
        disposeVersion: (appId, version) => svc().disposeVersion(caller, appId, version),
        listArtifacts: async appId => svc().listArtifacts(caller, appId),
        onBridgeCall: async handler => { svc().setBridgeHandler(caller, typeof handler === 'function' ? handler : undefined); },
      };
    }
    return Object.keys(facade).length > 0 ? facade : undefined;
  }

  /** MC16：SandboxModule 不导入 AppStoreModule，类在用到时才 require，经全局容器取得 */
  private sandboxService(): SandboxServiceLike {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { SandboxService } = require('../../sandbox/sandbox.service');
    const svc = this.moduleRef.get(SandboxService, { strict: false }) as SandboxServiceLike | undefined;
    if (!svc) throw new Error('Sandbox service is not available');
    return svc;
  }

  private temporalSettings() {
    return resolveTemporalSettings(this.appConfig?.getSystemConfig() ?? {});
  }

  // ── host 原语实现（appstore:host，MC02）──
  // AppGrantService、AppUninstallService、AppAuditService 惰性取得：AppUninstallService 经
  // AppActivationService 依赖本服务，构造注入会成环

  private audit(): AppAuditService {
    return this.moduleRef.get(AppAuditService, { strict: false });
  }

  private isHostedBy(app: { manifest?: AppManifest | null } | null | undefined, caller: string): boolean {
    return (app?.manifest?.tags ?? []).includes(`${HOSTED_BY_TAG_PREFIX}${caller}`);
  }

  /** 权限查询的目标：调用方自身或其托管的应用；否则拒绝 */
  private async requireSelfOrHosted(caller: string, appId: string) {
    const app = await this.registry.findOne(appId);
    if (!app) throw new NotFoundException(`App ${appId} not found`);
    if (appId !== caller && !this.isHostedBy(app, caller)) {
      throw new ForbiddenException(`App ${appId} is not hosted by ${caller}`);
    }
    return app;
  }

  private async listHostedApps(caller: string): Promise<HostedAppInfo[]> {
    const apps = (await this.registry.findAll()).filter(a => this.isHostedBy(a, caller));
    await this.audit().log(caller, 'host_list_hosted_apps', null, { count: apps.length });
    return apps.map(a => ({
      appId: a.appId,
      version: a.version,
      status: a.status,
      tags: [...(a.manifest?.tags ?? [])],
    }));
  }

  private async uninstallHostedApp(caller: string, appId: string, opts?: { purgeData?: boolean }): Promise<void> {
    const app = await this.registry.findOne(appId);
    if (!app) throw new NotFoundException(`App ${appId} not found`);
    if (!this.isHostedBy(app, caller)) {
      throw new ForbiddenException(`App ${appId} is not hosted by ${caller}`);
    }
    const purgeData = opts?.purgeData === true;
    await this.moduleRef.get(lazyUninstall(), { strict: false }).uninstall(appId, { purgeData });
    await this.audit().log(caller, 'host_uninstall_app', null, { appId, purgeData });
  }

  private async getAppPermissions(caller: string, appId: string, userId: string): Promise<string[]> {
    const app = await this.requireSelfOrHosted(caller, appId);
    const declared = (app.manifest?.permissions ?? []).map(p => p.id);
    const user = await loadActiveUser(this.db, userId);
    let held: string[] = [];
    if (user && user.permissions.includes('sys:admin')) {
      held = declared;
    } else if (user) {
      const grants = this.moduleRef.get(AppGrantService, { strict: false });
      const principal = userPrincipalOf(user, `app-platform:${caller}`);
      for (const permissionId of declared) {
        if (await grants.hasPermissionForPrincipal(appId, permissionId, principal)) held.push(permissionId);
      }
    }
    await this.audit().log(caller, 'host_get_app_permissions', null, {
      appId, userId, found: !!user, count: held.length,
    });
    return held;
  }

  private async getUserProfile(caller: string, userId: string): Promise<HostUserProfile | null> {
    const user = await loadActiveUser(this.db, userId);
    await this.audit().log(caller, 'host_get_user_profile', null, { userId, found: !!user });
    return user
      ? { id: user.id, name: user.name, roleId: user.roleId, departmentIds: user.departmentIds, permissions: user.permissions }
      : null;
  }

  /**
   * 按 jz_app_grants 展开权限持有人：直授用户、角色成员（jz_users.role_id）、部门成员（jz_department_members，
   * 只看直属成员，与 AppGrantService 的判定一致）。去重、排除停用用户；departmentIds 给出时只保留属于其中
   * 任一部门的用户（空数组即无人）。不看 default，管理员没有显式授权时不返回。
   */
  private async listPermissionHolders(
    caller: string, appId: string, permissionId: string, opts?: { departmentIds?: string[] },
  ): Promise<PermissionHolders> {
    const app = await this.requireSelfOrHosted(caller, appId);
    if (!(app.manifest?.permissions ?? []).some(p => p.id === permissionId)) {
      throw new BadRequestException(`Permission ${permissionId} not declared by ${appId}`);
    }
    const departmentIds = opts?.departmentIds ? [...opts.departmentIds] : null;
    const { rows } = await this.db.query(
      `WITH g AS (
         SELECT target_type, target_id FROM jz_app_grants
         WHERE app_id = $1 AND permission_id = $2 AND level <> 'none'
       ), holders AS (
         SELECT target_id AS user_id FROM g WHERE target_type = 'user'
         UNION
         SELECT u.id FROM jz_users u JOIN g ON g.target_type = 'role' AND u.role_id = g.target_id
         UNION
         SELECT dm.user_id FROM jz_department_members dm
           JOIN g ON g.target_type = 'department' AND dm.department_id = g.target_id
       )
       SELECT u.id FROM holders h JOIN jz_users u ON u.id = h.user_id
       WHERE u.status <> 'disabled'
         AND ($3::text[] IS NULL OR EXISTS (
           SELECT 1 FROM jz_department_members d WHERE d.user_id = u.id AND d.department_id = ANY($3::text[])
         ))
       ORDER BY u.id
       LIMIT ${PERMISSION_HOLDERS_LIMIT + 1}`,
      [appId, permissionId, departmentIds],
    );
    const truncated = rows.length > PERMISSION_HOLDERS_LIMIT;
    const userIds = rows.slice(0, PERMISSION_HOLDERS_LIMIT).map((r: any) => r.id);
    await this.audit().log(caller, 'host_list_permission_holders', null, {
      appId, permissionId, departmentIds, count: userIds.length, truncated,
    });
    return { userIds, truncated };
  }

  /**
   * 用户的上级：资料中的上级优先；没有时为所在部门的负责人（head_user_id 与成员角色 head，不含本人）；
   * 本人是所在部门的负责人时取上级部门的负责人。结果只含在用的用户。
   */
  private async listUserManagers(caller: string, userIds: string[]): Promise<Record<string, string[]>> {
    if (!Array.isArray(userIds) || userIds.some(id => typeof id !== 'string')) {
      throw new BadRequestException('userIds must be an array of strings');
    }
    const ids = [...new Set(userIds)];
    if (ids.length > USER_MANAGERS_LIMIT) throw new BadRequestException(`At most ${USER_MANAGERS_LIMIT} users per call`);
    const out: Record<string, string[]> = Object.fromEntries(ids.map(id => [id, [] as string[]]));
    if (!ids.length) return out;
    const { rows } = await this.db.query(
      `WITH u AS (SELECT unnest($1::text[]) AS user_id),
       heads AS (
         SELECT d.id AS dept_id, d.parent_id, d.head_user_id AS head FROM jz_departments d WHERE d.head_user_id IS NOT NULL
         UNION
         SELECT d.id, d.parent_id, m.user_id FROM jz_departments d
           JOIN jz_department_members m ON m.department_id = d.id AND m.role = 'head'
       ),
       profile AS (
         SELECT u.user_id, p.manager_id AS manager, 1 AS rank FROM u
           JOIN jz_user_profiles p ON p.user_id = u.user_id WHERE p.manager_id IS NOT NULL AND p.manager_id <> u.user_id
       ),
       dept AS (
         SELECT u.user_id, h.head AS manager, 2 AS rank FROM u
           JOIN jz_department_members dm ON dm.user_id = u.user_id
           JOIN heads h ON h.dept_id = dm.department_id WHERE h.head <> u.user_id
       ),
       parent AS (
         SELECT u.user_id, ph.head AS manager, 3 AS rank FROM u
           JOIN heads own ON own.head = u.user_id
           JOIN heads ph ON ph.dept_id = own.parent_id WHERE ph.head <> u.user_id
       ),
       c AS (SELECT * FROM profile UNION ALL SELECT * FROM dept UNION ALL SELECT * FROM parent)
       SELECT c.user_id, c.manager, c.rank FROM c JOIN jz_users mu ON mu.id = c.manager
       WHERE mu.status <> 'disabled'
       ORDER BY c.user_id, c.rank, c.manager`,
      [ids],
    );
    const best = new Map<string, number>();
    for (const r of rows as Array<{ user_id: string; manager: string; rank: number }>) {
      const rank = Number(r.rank);
      const top = best.get(r.user_id);
      if (top !== undefined && rank > top) continue;
      best.set(r.user_id, rank);
      if (!out[r.user_id].includes(r.manager)) out[r.user_id].push(r.manager);
    }
    await this.audit().log(caller, 'host_list_user_managers', null, {
      count: ids.length, found: Object.values(out).filter(m => m.length).length,
    });
    return out;
  }

  // ── market 原语实现 ──

  private async setAppStatus(appId: string, status: 'active' | 'license_expired'): Promise<void> {    if (!['active', 'license_expired'].includes(status)) {
      throw new Error(`setAppStatus 仅允许 active | license_expired，收到 ${status}`);
    }
    const app = await this.registry.findOne(appId);
    if (!app) throw new Error(`App ${appId} not found`);
    // 只允许在授权相关状态间迁移，不干预 installing/upgrading/failed 等运行时状态
    if (!['active', 'license_expired'].includes(app.status)) {
      throw new Error(`App ${appId} 当前状态 ${app.status} 不允许审计回写`);
    }
    // MC11：运行状态跟随授权状态。恢复为 active 由运行时复查完整性后改注册表；到期先改注册表再停用或进入只读期
    const runtime = this.licenseRuntime();
    if (status === 'active' && app.status === 'license_expired' && runtime) {
      await runtime.restore(app);
      return;
    }
    await this.registry.updateStatus(appId, status);
    if (runtime && status === 'license_expired') await runtime.applyStatus(appId, app.status, status);
  }

  private licenseRuntime(): AppLicenseRuntimeService | undefined {
    try {
      return this.moduleRef.get(AppLicenseRuntimeService, { strict: false });
    } catch {
      return undefined;
    }
  }

  private async getInstallationToken(): Promise<string> {
    let rows: any[];
    try {
      ({ rows } = await this.db.query(
        `SELECT installation_token, previous_token, previous_token_expires
         FROM jz_installation
         ORDER BY installation_token IS NOT NULL DESC, setup_phase DESC LIMIT 1`,
      ));
    } catch {
      // 老库无 previous_token 列（043 迁移前）
      ({ rows } = await this.db.query(
        `SELECT installation_token FROM jz_installation
         ORDER BY installation_token IS NOT NULL DESC, setup_phase DESC LIMIT 1`,
      ));
    }
    const row = rows[0];
    if (row?.installation_token) return row.installation_token;
    if (row?.previous_token && row.previous_token_expires && new Date(row.previous_token_expires) > new Date()) {
      return row.previous_token;
    }
    throw new Error('本实例尚未注册官网账号，无法访问应用商城');
  }

  private async getInstallationId(): Promise<string> {
    const { rows } = await this.db.query(
      `SELECT id FROM jz_installation
       ORDER BY installation_token IS NOT NULL DESC, setup_phase DESC LIMIT 1`,
    );
    if (!rows[0]?.id) throw new Error('本实例 installationId 尚未初始化');
    return rows[0].id;
  }

  private async listInstalledApps() {
    const apps = await this.registry.findAll();
    return apps.map(a => ({
      appId: a.appId,
      version: a.version,
      status: a.status,
      licenseBlob: a.licenseBlob ?? null,
      licenseExpiresAt: a.licenseExpiresAt ? a.licenseExpiresAt.toISOString() : null,
      licenseReadonlyUntil: a.licenseReadonlyUntil ? new Date(a.licenseReadonlyUntil).toISOString() : null,
      installDir: a.installDir ?? null,
    }));
  }

  // ── 商城安装进度原语 ──

  private async beginInstallOperation(): Promise<{ stageId: string }> {
    const op = this.operations.create({
      phase: 'downloading', percent: 0, message: '正在下载应用包…', autoInstall: true,
    });
    return { stageId: op.stageId };
  }

  private async updateInstallProgress(stageId: string, percent: number, message: string): Promise<void> {
    const status = this.operations.get(stageId);
    // 仅允许商城侧写 downloading 阶段；后续阶段由安装链路状态机驱动
    if (status.phase !== 'downloading') return;
    const clamped = Math.max(0, Math.min(45, Math.round(percent)));
    this.operations.update(stageId, 'downloading', clamped, message);
  }

  private async failInstallOperation(stageId: string, message: string): Promise<void> {
    const status = this.operations.get(stageId);
    if (['succeeded', 'failed', 'expired'].includes(status.phase)) return;
    this.operations.fail(stageId, message);
  }

  /**
   * 挂到已有操作上的商城安装：staging 校验（挂接同一 stageId）→ installFromStage 全程进度 → succeed。
   * 失败时操作已处于 failed（staging 失败）或由本方法标记。
   */
  private async installPackageTracked(stageId: string, packagePath: string): Promise<{ appId: string }> {
    this.staging.start(packagePath, stageId);
    const deadline = Date.now() + 10 * 60 * 1000;
    let status = this.operations.get(stageId);
    while (Date.now() < deadline) {
      status = this.operations.get(stageId);
      if (status.phase === 'ready') break;
      if (['failed', 'expired'].includes(status.phase)) {
        throw new Error(status.errors.join('; ') || status.message);
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (status.phase !== 'ready') {
      this.operations.fail(stageId, '安装准备超时');
      throw new Error('安装准备超时');
    }

    const stageDir = this.operations.getInstallStageDir(stageId);
    const integrity = this.operations.getIntegrity(stageId);
    try {
      await this.moduleRef.get(lazyInstall(), { strict: false }).installFromStage(
        stageDir, {},
        (phase, percent, message) => this.operations.update(stageId, phase, percent, message),
        {
          purgeOrphanedData: false,
          packageSha256: integrity?.packageSha256 ?? null,
          signatureVerified: integrity?.signatureVerified ?? false,
        },
      );
      this.operations.succeed(stageId);
    } catch (err: any) {
      this.operations.fail(stageId, err.message || '应用安装失败');
      throw err;
    } finally {
      this.operations.clearStageDir(stageId);
    }
    return { appId: status.manifest!.appId };
  }

  /** 挂到已有操作上的商城升级：upgrade 全程进度写入该操作 */
  private async upgradePackageTracked(stageId: string, appId: string, packagePath: string): Promise<void> {
    try {
      await this.moduleRef.get(lazyUpgrade(), { strict: false }).upgrade(
        appId, packagePath,
        (phase: 'unpacking' | 'validating' | 'installing' | 'migrating' | 'activating', percent: number, message: string) =>
          this.operations.update(stageId, phase, percent, message),
      );
      this.operations.succeed(stageId);
    } catch (err: any) {
      this.operations.fail(stageId, err.message || '应用升级失败');
      throw err;
    }
  }

  // ── 实现 ──

  /**
   * 安装后的实际状态：需要授权而没有有效许可证的应用装好后是 license_expired（MC11），
   * 不能固定返回 active，否则开发 MCP 的调用方以为应用可用（T-S1-01 发现）。
   */
  private async installedStatus(appId: string): Promise<string> {
    return (await this.registry.findOne(appId))?.status ?? 'active';
  }

  private async stageAndInstall(
    files: Record<string, string>,
    config?: Record<string, unknown>,
  ): Promise<{ appId: string; status: string }> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'jzdev-install-'));
    try {
      await this.writeFiles(dir, files);
      const manifest = this.readManifest(dir);
      await this.moduleRef.get(lazyInstall(), { strict: false })
        .installFromStage(dir, config ?? {}, () => {}, {});
      return { appId: manifest.appId, status: await this.installedStatus(manifest.appId) };
    } finally {
      fs.rm(dir, { recursive: true, force: true }, () => {});
    }
  }

  private async upgradeApp(appId: string, files: Record<string, string>): Promise<{ ok: true }> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'jzdev-upgrade-'));
    const zipPath = path.join(os.tmpdir(), `jzdev_${Date.now()}.jzapp`);
    try {
      await this.writeFiles(dir, files);
      await this.zipDir(dir, zipPath);
      await this.moduleRef.get(lazyUpgrade(), { strict: false }).upgrade(appId, zipPath);
      return { ok: true };
    } finally {
      fs.rm(dir, { recursive: true, force: true }, () => {});
      fs.rm(zipPath, { force: true }, () => {});
    }
  }

  private async validatePackage(
    files: Record<string, string>,
  ): Promise<{ ok: boolean; issues: Array<{ code: string; path?: string; message: string; hint?: string }> }> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'jzdev-validate-'));
    try {
      await this.writeFiles(dir, files);
      return await this.validateDir(dir);
    } finally {
      fs.rm(dir, { recursive: true, force: true }, () => {});
    }
  }

  // ── 大包上传通道（uploadId → 包路径 → 与 files 版同链路）──

  private async installFromUpload(
    uploadId: string,
    config?: Record<string, unknown>,
  ): Promise<{ appId: string; status: string }> {
    const packagePath = this.uploads.consume(uploadId);
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'jzdev-install-'));
    try {
      await this.archives.extract(packagePath, dir);
      const manifest = this.readManifest(dir);
      await this.moduleRef.get(lazyInstall(), { strict: false })
        .installFromStage(dir, config ?? {}, () => {}, {});
      return { appId: manifest.appId, status: await this.installedStatus(manifest.appId) };
    } finally {
      fs.rm(dir, { recursive: true, force: true }, () => {});
      this.uploads.release(uploadId);
    }
  }

  private async upgradeFromUpload(appId: string, uploadId: string): Promise<{ ok: true }> {
    const packagePath = this.uploads.consume(uploadId);
    try {
      await this.moduleRef.get(lazyUpgrade(), { strict: false }).upgrade(appId, packagePath);
      return { ok: true };
    } finally {
      this.uploads.release(uploadId);
    }
  }

  private async validateFromUpload(
    uploadId: string,
  ): Promise<{ ok: boolean; issues: Array<{ code: string; path?: string; message: string; hint?: string }> }> {
    const packagePath = this.uploads.consume(uploadId);
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'jzdev-validate-'));
    try {
      await this.archives.extract(packagePath, dir);
      return await this.validateDir(dir);
    } finally {
      fs.rm(dir, { recursive: true, force: true }, () => {});
      this.uploads.release(uploadId);
    }
  }

  private async validateDir(
    dir: string,
  ): Promise<{ ok: boolean; issues: Array<{ code: string; path?: string; message: string; hint?: string }> }> {
    const ids = await this.registry.getExistingIds();
    const report = await this.moduleRef.get(AppValidatorService, { strict: false }).validate(
      dir, ids.appIds, ids.shortNames, ids.nsPrefixes, ids.schemaNames, ids.panelIds, ids.toolIds,
    );
    const issues = [...report.criticals, ...report.warnings].map((c: any) => ({
      code: c.code,
      message: c.message,
      path: c.details,
      hint: this.hintFor(c.code),
    }));
    return { ok: report.passed, issues };
  }

  /** 机器可读修复建议（dev agent 自纠用） */
  private hintFor(code: string): string | undefined {
    const hints: Record<string, string> = {
      MISSING_MANIFEST: '在包根目录添加 manifest.json（参照 jzdev://docs/manifest-schema）',
      INVALID_MANIFEST: '按 jzdev://docs/manifest-schema 修正字段格式',
      DUPLICATE_APP_ID: '更换 appId（反向域名，全局唯一）',
      DUPLICATE_SHORT_NAME: '更换 shortName',
      DUPLICATE_NS_PREFIX: '更换 nsPrefix，并同步改所有标识符前缀',
      AGENT_TOOL_NOT_DECLARED: '把该工具加入 manifest backend.toolProviders[].toolIds，或从 agent yaml 的 tools 中移除',
      PLATFORM_TOOL_NOT_ALLOWED: '从 usesPlatformTools 移除该工具；仅 L1 数据生成/L2 连接器只读/L3 界面控制类可声明',
      DEV_CAP_NOT_FIRST_PARTY: 'appstore:* 能力仅首方包可声明，请移除',
      PLATFORM_CAP_NOT_FIRST_PARTY: 'platform:*（如 platform:temporal）是平台组件通道，仅首方包可声明，请移除',
      LICENSE_POLICY_NOT_FIRST_PARTY: 'licensePolicy.onExpired "readonly" 仅首方包可用，请改为 "deactivate" 或删除 licensePolicy',
      INBOX_ACTION_HANDLER_UNKNOWN: 'inbox.actionHandler 须写成 "Class.method"，并列在 backend.controllers[].handlers 中',
      PERM_GROUP_INVALID: 'permissions[].group 只能取 function、operation、scope、field、other（审批与联动调整归 operation），或不写（按 other）',
      PERM_TOO_MANY: '单个应用最多 500 个权限项：合并同类权限，或把功能拆到多个应用',
      PERM_MANY: '权限项超过 300 个时设置页难以维护：考虑合并同类权限，或把功能拆到多个应用',
      MCP_EXPOSE_NOT_FIRST_PARTY: 'mcpExposed 仅首方包可声明，请移除',
      RESERVED_APP_ID_NAMESPACE: `${RESERVED_NAMESPACE_LABEL} 为保留命名空间，请改用自己的反向域名 appId（首方应用为 io.jzai.*）`,
      PROCESS_RUNTIME_NOT_FIRST_PARTY: 'backend.runtime "process"（独立进程）仅首方包可用，请移除该字段',
      POOL_MAX_NOT_FIRST_PARTY: 'database.poolMax 第三方包最多为 5，请改为 5 或更小（不写时默认 3）；6 至 20 只开放给首方包（io.jzai.*）',
      MIGRATION_VERSION_GAP: 'migrations 版本号从 1 开始连续编号',
      MIGRATION_FILE_MISSING: '补齐迁移 SQL 文件或从 manifest.migrations 移除该条',
      MISSING_README: '补充 README.md（≥200 字符，说明用途与配置）',
    };
    return hints[code];
  }

  private async listPlatformTools(): Promise<Array<{ id: string; group?: string; description?: string; source: string }>> {
    const bridge = this.moduleRef.get(ToolBridgeService, { strict: false });
    const catalog = bridge.getCatalog();
    const sourceMap = await this.capabilities.getSourceMap();
    const appTools = sourceMap.get('tool') ?? new Map();
    return catalog.map((e: any) => {
      const src = appTools.get(e.id ?? e.name);
      return {
        id: e.id ?? e.name,
        group: e.group,
        description: e.description,
        source: src ? `app:${src.name}` : 'builtin',
      };
    });
  }

  private async describeTool(toolId: string): Promise<unknown> {
    const all = await this.listPlatformTools();
    const found = all.find(t => t.id === toolId);
    if (!found) throw new Error(`Tool not found: ${toolId}`);
    const bridge = this.moduleRef.get(ToolBridgeService, { strict: false });
    const full = bridge.getCatalog().find((e: any) => (e.id ?? e.name) === toolId);
    return { ...found, parameters: (full as any)?.parameters ?? null };
  }

  // ── 工具方法 ──

  private async writeFiles(dir: string, files: Record<string, string>): Promise<void> {
    const entries = Object.entries(files);
    if (entries.length > 5000) throw new Error('Too many files: maximum is 5000');
    const totalBytes = entries.reduce((sum, [, content]) => sum + Buffer.byteLength(content, 'utf-8'), 0);
    if (totalBytes > 200 * 1024 * 1024) throw new Error('File content exceeds 200MB limit');

    const seen = new Map<string, string>();
    for (const [rel, content] of entries) {
      if (!rel || rel.includes('\0') || rel.includes('\\') || path.posix.isAbsolute(rel)
        || path.win32.isAbsolute(rel) || rel.split('/').includes('..')) {
        throw new Error(`Illegal file path: ${rel}`);
      }
      const normalized = path.posix.normalize(rel);
      const lower = normalized.toLocaleLowerCase('en-US');
      const previous = seen.get(lower);
      if (previous) throw new Error(`Duplicate or case-conflicting file path: ${previous} / ${rel}`);
      seen.set(lower, normalized);

      const target = path.resolve(dir, normalized);
      if (!target.startsWith(path.resolve(dir) + path.sep)) throw new Error(`Illegal file path: ${rel}`);
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.writeFile(target, content);
    }
  }

  private readManifest(dir: string): AppManifest {
    return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'));
  }

  private zipDir(dir: string, out: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const zip = spawn('zip', ['-qry', out, '.', '-x', '._*', '*/._*', '.DS_Store', '*/.DS_Store'], { cwd: dir });
      zip.on('close', code => (code === 0 ? resolve() : reject(new Error(`zip exited ${code}`))));
      zip.on('error', reject);
    });
  }
}
