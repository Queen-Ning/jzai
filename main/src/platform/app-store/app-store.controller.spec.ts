import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { AppStoreController } from './app-store.controller';
import { ORPHANED_DATABASE_RESOURCES_ERROR } from './services/app-install.service';
import { APP_CONFIG_ARTIFACT_PERMISSION } from './services/app-activation.service';
import { InvocationContextFactory } from './runtime/invocation-context.factory';

describe('AppStoreController', () => {
  let controller: AppStoreController;
  let registry: any;
  let uninstall: any;
  let upgrade: any;
  let grants: any;
  let audit: any;
  let staging: any;
  let operations: any;
  let instances: any;
  let loader: any;
  let appLogs: any;
  let connectionBindings: any;
  let moduleRef: any;
  let toolBridge: any;

  const adminReq = {
    user: { id: 'admin-user', role: { permissions: ['sys:admin'] } },
  };
  const grantedUserReq = {
    user: { id: 'granted-user', role: { permissions: [] } },
  };
  const nonAdminRequests = [
    { user: { id: 'regular-user', role: { permissions: [] } } },
    {},
  ];

  beforeEach(() => {
    registry = {
      findOne: jest.fn().mockResolvedValue({ appId: 'com.example.app', manifest: {}, config: {}, status: 'failed' }),
      updateConfig: jest.fn(),
    };
    uninstall = { uninstall: jest.fn() };
    upgrade = { upgrade: jest.fn() };
    grants = {
      getGrants: jest.fn(),
      setGrant: jest.fn(),
      hasAppAccess: jest.fn(),
      hasAppAccessForPrincipal: jest.fn(),
      getRequiredHandlerPermission: jest.fn().mockResolvedValue(undefined),
      hasPermissionForPrincipal: jest.fn().mockResolvedValue(false),
    };
    audit = { getLogs: jest.fn(), log: jest.fn().mockResolvedValue(undefined) };
    staging = { start: jest.fn() };
    operations = {
      get: jest.fn(),
      getInstallStageDir: jest.fn(),
      update: jest.fn(),
    };
    instances = { getAll: jest.fn() };
    loader = { getModuleRef: jest.fn() };
    appLogs = {
      read: jest.fn().mockReturnValue([]),
      subscribe: jest.fn().mockReturnValue(jest.fn()),
    };
    connectionBindings = {
      listBindings: jest.fn(),
      describeBinding: jest.fn(),
      invoke: jest.fn(),
      createClient: jest.fn().mockReturnValue(Object.freeze({
        listBindings: jest.fn(),
        describe: jest.fn(),
        invoke: jest.fn(),
      })),
    };
    toolBridge = { callTool: jest.fn().mockResolvedValue({ ok: true }) };
    moduleRef = { get: jest.fn().mockReturnValue(toolBridge) };

    controller = new AppStoreController(
      registry,
      {} as any,
      uninstall,
      upgrade,
      grants,
      audit,
      staging,
      operations,
      instances,
      {} as any,
      { maskConfig: jest.fn((config: any) => config), extractAndStoreSecrets: jest.fn((_id: string, c: any) => Promise.resolve(c)) } as any,
      { deactivateApp: jest.fn(), activateApp: jest.fn().mockResolvedValue(undefined), isDraining: jest.fn().mockReturnValue(false) } as any,
      loader,
      appLogs,
      new InvocationContextFactory(),
      connectionBindings,
      { isDegraded: jest.fn().mockReturnValue({ degraded: false }), listServices: jest.fn().mockReturnValue([]) } as any,
      moduleRef,
    );
  });

  describe('admin authorization', () => {
    it.each(nonAdminRequests)('rejects every management endpoint before side effects', async req => {
      const calls: Array<() => unknown> = [
        () => controller.stagePackage(undefined as any, req),
        () => controller.getStageStatus('stage-1', req),
        () => controller.installApp({ stageId: 'stage-1' }, req),
        () => controller.upgradeApp('com.example.app', undefined as any, req),
        () => controller.uninstallApp('com.example.app', undefined, req),
        () => controller.getGrants('com.example.app', req),
        () => controller.setGrant('com.example.app', { userId: 'user-1' }, req),
        () => controller.getAuditLog('com.example.app', undefined, req),
        () => controller.getInstances(req),
        () => controller.updateConfig('com.example.app', { enabled: true }, req),
      ];

      for (const call of calls) {
        await expect(Promise.resolve().then(call)).rejects.toBeInstanceOf(ForbiddenException);
      }

      expect(staging.start).not.toHaveBeenCalled();
      expect(operations.get).not.toHaveBeenCalled();
      expect(operations.getInstallStageDir).not.toHaveBeenCalled();
      expect(upgrade.upgrade).not.toHaveBeenCalled();
      expect(uninstall.uninstall).not.toHaveBeenCalled();
      expect(grants.getGrants).not.toHaveBeenCalled();
      expect(grants.setGrant).not.toHaveBeenCalled();
      expect(audit.getLogs).not.toHaveBeenCalled();
      expect(instances.getAll).not.toHaveBeenCalled();
      expect(registry.updateConfig).not.toHaveBeenCalled();
    });

    it('allows administrators to access management endpoints', async () => {
      operations.get.mockReturnValue({ stageId: 'stage-1', phase: 'ready' });
      grants.getGrants.mockResolvedValue([{ userId: 'user-1' }]);
      audit.getLogs.mockResolvedValue([{ action: 'installed' }]);
      instances.getAll.mockResolvedValue([{ instanceId: 'instance-1' }]);

      expect(controller.getStageStatus('stage-1', adminReq)).toEqual({ stageId: 'stage-1', phase: 'ready' });
      await expect(controller.getGrants('com.example.app', adminReq)).resolves.toEqual([{ userId: 'user-1' }]);
      await expect(controller.getAuditLog('com.example.app', '10', adminReq)).resolves.toEqual([{ action: 'installed' }]);
      await expect(controller.getInstances(adminReq)).resolves.toEqual([{ instanceId: 'instance-1' }]);
      await expect(controller.updateConfig('com.example.app', { enabled: true }, adminReq)).resolves.toEqual({ ok: true });

      expect(registry.updateConfig).toHaveBeenCalledWith('com.example.app', { enabled: true });
    });

    it('uses the route appId when a grant body contains a different appId', async () => {
      await controller.setGrant(
        'com.example.route-app',
        { appId: 'com.example.body-app', permissionId: 'ex:use', targetType: 'user', targetId: 'user-1', level: 'user' },
        adminReq,
      );

      expect(grants.setGrant).toHaveBeenCalledWith({
        appId: 'com.example.route-app',
        permissionId: 'ex:use',
        targetType: 'user',
        targetId: 'user-1',
        level: 'user',
      });
    });

    // T-P-20（MC12）：授权写入校验请求体并写审计；汇总接口只给管理员
    it('validates the grant body and writes a grant_change audit entry per write', async () => {
      const bad = [
        {},
        { permissionId: 'ex:use', targetType: 'group', targetId: 'g1' },
        { permissionId: 'ex:use', targetType: 'user', targetId: ' ' },
        { permissionId: 'ex:use', targetType: 'user', targetId: 'u1', level: 'owner' },
      ];
      for (const body of bad) {
        await expect(controller.setGrant('com.example.app', body, adminReq)).rejects.toBeInstanceOf(BadRequestException);
      }
      expect(grants.setGrant).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();

      await controller.setGrant('com.example.app', { permissionId: 'ex:use', targetType: 'role', targetId: 'r1' }, adminReq);
      expect(grants.setGrant).toHaveBeenCalledWith(expect.objectContaining({ targetType: 'role', targetId: 'r1', level: 'user' }));
      await controller.setGrant('com.example.app', { permissionId: 'ex:use', targetType: 'role', targetId: 'r1', level: 'none' }, adminReq);
      expect(audit.log).toHaveBeenNthCalledWith(1, 'com.example.app', 'grant_change', 'admin-user',
        { permissionId: 'ex:use', targetType: 'role', targetId: 'r1', level: 'user' });
      expect(audit.log).toHaveBeenNthCalledWith(2, 'com.example.app', 'grant_change', 'admin-user',
        { permissionId: 'ex:use', targetType: 'role', targetId: 'r1', level: 'none' });
    });

    it('does not write an audit entry when the service rejects the grant', async () => {
      grants.setGrant.mockRejectedValueOnce(new BadRequestException('Permission ex:x not declared in manifest'));
      await expect(controller.setGrant('com.example.app', { permissionId: 'ex:x', targetType: 'user', targetId: 'u1' }, adminReq))
        .rejects.toBeInstanceOf(BadRequestException);
      expect(audit.log).not.toHaveBeenCalled();
    });

    it.each(nonAdminRequests)('rejects the grant summary for non-admins', async req => {
      grants.listGrantsByTarget = jest.fn();
      await expect(Promise.resolve().then(() => controller.getGrantSummary('com.example.app', req)))
        .rejects.toBeInstanceOf(ForbiddenException);
      expect(grants.listGrantsByTarget).not.toHaveBeenCalled();
    });
  });

  describe('granted user access regressions', () => {
    it('still allows a granted non-admin user to invoke a declared handler', async () => {
      const run = jest.fn().mockResolvedValue({ ok: true });
      registry.findOne.mockResolvedValue({
        manifest: {
          backend: {
            controllers: [{ handlers: ['ProbeController.run'] }],
          },
        },
      });
      grants.hasAppAccessForPrincipal.mockResolvedValue(true);
      loader.getModuleRef.mockReturnValue({
        controllers: { ProbeController: { run } },
      });

      await expect(controller.invokeHandler(
        'com.example.app',
        'ProbeController.run',
        { value: 1 },
        grantedUserReq,
      )).resolves.toEqual({ ok: true });

      expect(grants.hasAppAccessForPrincipal).toHaveBeenCalledWith(
        'com.example.app',
        expect.objectContaining({
          type: 'user',
          principalId: 'user:granted-user',
          userId: 'granted-user',
        }),
      );
      expect(run).toHaveBeenCalledWith(
        { value: 1 },
        expect.objectContaining({
          appId: 'com.example.app',
          requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
          userId: 'granted-user',
          principal: expect.objectContaining({ principalId: 'user:granted-user' }),
        }),
      );
    });

    it('binds Panel platform-tool calls to the authenticated principal and manifest allowlist', async () => {
      const run = jest.fn(async (_body: unknown, invocation: any) => {
        await invocation.tools.call('dashboard', { id: 'dash-1' });
        await expect(invocation.tools.call('email', {})).rejects.toBeInstanceOf(ForbiddenException);
        return { ok: true };
      });
      registry.findOne.mockResolvedValue({
        manifest: {
          usesPlatformTools: ['dashboard'],
          backend: {
            controllers: [{ handlers: ['ProbeController.run'] }],
          },
        },
      });
      grants.hasAppAccessForPrincipal.mockResolvedValue(true);
      loader.getModuleRef.mockReturnValue({
        controllers: { ProbeController: { run } },
      });

      await controller.invokeHandler(
        'com.example.app',
        'ProbeController.run',
        {},
        grantedUserReq,
      );

      expect(toolBridge.callTool).toHaveBeenCalledWith(
        'dashboard',
        { id: 'dash-1' },
        expect.objectContaining({ principalId: 'user:granted-user' }),
      );
      expect(toolBridge.callTool).toHaveBeenCalledTimes(1);
    });

    it('still allows a granted non-admin user to open the app log stream', async () => {
      registry.findOne.mockResolvedValue({ appId: 'com.example.app' });
      grants.hasAppAccessForPrincipal.mockResolvedValue(true);

      await expect(controller.streamLogs(
        'com.example.app',
        '0',
        grantedUserReq,
      )).resolves.toBeDefined();

      expect(grants.hasAppAccessForPrincipal).toHaveBeenCalledWith(
        'com.example.app',
        expect.objectContaining({ userId: 'granted-user' }),
      );
    });
  });

  describe('installation failure messages', () => {
    const failureMessage = (error: unknown): string =>
      (controller as any).getInstallFailureMessage(error);

    it('maps invalid database URLs to actionable configuration guidance', () => {
      expect(failureMessage(new TypeError('Invalid URL'))).toBe(
        '平台数据库连接配置无效，请检查数据库主机、端口和数据库名称。',
      );
    });

    it('maps backend activation failures without exposing raw internals', () => {
      const message = failureMessage(new Error('Backend entry not found for probe: /tmp/probe.js'));

      expect(message).toBe('应用后端激活失败，请检查应用包的后端入口和工具配置后重新上传。');
      expect(message).not.toContain('/tmp/probe.js');
    });

    it('retains safe validation errors for the uploader', () => {
      expect(failureMessage(new BadRequestException('Package validation failed: manifest.json missing'))).toBe(
        'Package validation failed: manifest.json missing',
      );
    });

    it('maps orphaned database resources to a confirmed recovery action', () => {
      const message = failureMessage(new BadRequestException(ORPHANED_DATABASE_RESOURCES_ERROR));

      expect(message).toBe('发现同名应用的遗留数据库。请确认清除遗留数据后重试；此操作会永久删除旧应用数据。');
      expect(message).not.toContain(ORPHANED_DATABASE_RESOURCES_ERROR);
    });

    it('maps configuration artifact permission failures separately from database permissions', () => {
      const message = failureMessage(new Error(`${APP_CONFIG_ARTIFACT_PERMISSION}: /app/main/config/agents/dt_dimension_classifier.yaml`));

      expect(message).toBe('应用配置目录权限不足。请由管理员清理或修复旧的挂载配置文件后重试。');
      expect(message).not.toContain('数据库权限');
    });
  });

  // T-P-18（MC11）：到期调用拦截、只读期透传与离线许可证导入
  describe('license (MC11 / T-P-18)', () => {
    let appLicenses: any;
    let licensed: AppStoreController;
    const run = jest.fn();
    const paidApp = (extra: Record<string, unknown> = {}) => ({
      appId: 'com.example.app',
      status: 'active',
      manifest: { requiresLicense: true, backend: { controllers: [{ handlers: ['ProbeController.run'] }] } },
      config: {},
      ...extra,
    });

    beforeEach(() => {
      run.mockReset().mockResolvedValue({ ok: true });
      appLicenses = {
        verifyForImport: jest.fn().mockResolvedValue({ expiresAt: new Date('2027-01-01T00:00:00Z') }),
        setLicense: jest.fn().mockResolvedValue({ status: 'active', restored: true, expiresAt: '2027-01-01T00:00:00.000Z', expired: false }),
      };
      loader.getModuleRef.mockReturnValue({ controllers: { ProbeController: { run } } });
      licensed = new AppStoreController(
        registry, {} as any, uninstall, upgrade, grants, audit, staging, operations, instances, {} as any,
        { maskConfig: jest.fn((c: any) => c), extractAndStoreSecrets: jest.fn((_id: string, c: any) => Promise.resolve(c)) } as any,
        { deactivateApp: jest.fn(), activateApp: jest.fn().mockResolvedValue(undefined), isDraining: jest.fn().mockReturnValue(false) } as any,
        loader, appLogs, new InvocationContextFactory(), connectionBindings,
        { isDegraded: jest.fn().mockReturnValue({ degraded: false }), listServices: jest.fn().mockReturnValue([]) } as any,
        moduleRef,
        undefined as any,
        appLicenses,
      );
    });

    // T-P-18-C08（调用侧）
    it('rejects invoke with 403 APP_LICENSE_EXPIRED when the license expired and no read-only period applies', async () => {
      registry.findOne.mockResolvedValue(paidApp({ status: 'license_expired', licenseReadonlyUntil: null }));
      const err = await licensed.invokeHandler('com.example.app', 'ProbeController.run', {}, adminReq).catch(e => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).getResponse()).toEqual(expect.objectContaining({ code: 'APP_LICENSE_EXPIRED' }));
      expect(run).not.toHaveBeenCalled();
    });

    it('rejects invoke after the read-only period has ended', async () => {
      registry.findOne.mockResolvedValue(paidApp({ status: 'license_expired', licenseReadonlyUntil: new Date(Date.now() - 1000) }));
      const err = await licensed.invokeHandler('com.example.app', 'ProbeController.run', {}, adminReq).catch(e => e);
      expect((err as ForbiddenException).getResponse()).toEqual(expect.objectContaining({ code: 'APP_LICENSE_EXPIRED' }));
    });

    it('forwards invoke during the read-only period and tells the app via invocation.license', async () => {
      const until = new Date(Date.now() + 7 * 86_400_000);
      registry.findOne.mockResolvedValue(paidApp({ status: 'license_expired', licenseReadonlyUntil: until }));
      await expect(licensed.invokeHandler('com.example.app', 'ProbeController.run', {}, adminReq)).resolves.toEqual({ ok: true });
      expect(run).toHaveBeenCalledWith({}, expect.objectContaining({
        license: { state: 'readonly', readonlyUntil: until.toISOString() },
      }));
    });

    it('passes a valid license snapshot for an active app', async () => {
      registry.findOne.mockResolvedValue(paidApp());
      await licensed.invokeHandler('com.example.app', 'ProbeController.run', {}, adminReq);
      expect(run).toHaveBeenCalledWith({}, expect.objectContaining({ license: { state: 'valid', readonlyUntil: null } }));
    });

    // T-P-18-C08（导入侧）
    it('imports a valid license as admin, restores the app and writes an audit entry', async () => {
      registry.findOne.mockResolvedValue(paidApp({ status: 'license_expired' }));
      await expect(licensed.importLicense('com.example.app', { license: '  blob  ' }, adminReq))
        .resolves.toEqual(expect.objectContaining({ ok: true, status: 'active', restored: true }));
      expect(appLicenses.verifyForImport).toHaveBeenCalledWith('com.example.app', 'blob');
      expect(appLicenses.setLicense).toHaveBeenCalledWith('com.example.app', 'blob');
      expect(audit.log).toHaveBeenCalledWith('com.example.app', 'license_import', 'admin-user', expect.objectContaining({ restored: true }));
    });

    it('rejects an invalid license with 400 and leaves the stored license unchanged', async () => {
      registry.findOne.mockResolvedValue(paidApp({ status: 'license_expired' }));
      appLicenses.verifyForImport.mockRejectedValue(new Error('signature mismatch'));
      await expect(licensed.importLicense('com.example.app', { license: 'bad' }, adminReq)).rejects.toBeInstanceOf(BadRequestException);
      await expect(licensed.importLicense('com.example.app', {}, adminReq)).rejects.toBeInstanceOf(BadRequestException);
      expect(appLicenses.setLicense).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    });

    it.each(nonAdminRequests)('rejects license import for non-admins before any side effect', async req => {
      await expect(Promise.resolve().then(() => licensed.importLicense('com.example.app', { license: 'blob' }, req)))
        .rejects.toBeInstanceOf(ForbiddenException);
      expect(registry.findOne).not.toHaveBeenCalled();
      expect(appLicenses.verifyForImport).not.toHaveBeenCalled();
      expect(appLicenses.setLicense).not.toHaveBeenCalled();
    });
  });
});
