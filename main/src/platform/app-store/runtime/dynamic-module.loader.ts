import { Injectable, Logger, Optional } from '@nestjs/common';
import * as path from 'path';
import { AppContext } from './app-context';
import { ProcessRuntimeService } from './process/process-runtime.service';
import { hostContextFromAppContext } from './process/host-services';
import type { AppProcessSpec } from './process/app-process-host';
import type { AppLicenseSnapshot, AppLicenseState } from './process/protocol';

/** 'license'：授权到期停用（MC11） */
export type AppDeactivateReason = 'upgrade' | 'uninstall' | 'shutdown' | 'license';

export { VALID_LICENSE } from './process/protocol';
export type { AppLicenseState, AppLicenseSnapshot } from './process/protocol';

export interface LoadedApp {
  appId: string;
  entryPath: string;
  moduleRef: unknown;
  /** 'process' 时 moduleRef 是 ProxyModuleRef，后端在独立子进程中运行（MC09） */
  runtime?: 'in-process' | 'process';
}

export interface LoadOptions {
  runtime?: 'in-process' | 'process';
  /** runtime 为 'process' 时必填：子进程 init 规格与进程限额 */
  process?: AppProcessSpec;
}

/** onDeactivate 钩子最长等待时间，超时后继续卸载并在日志中诊断 */
const DEACTIVATE_HOOK_TIMEOUT_MS = 10_000;

/**
 * Loads and unloads extension backend modules at runtime.
 *
 * NestJS's LazyModuleLoader works well for NestJS modules, but because
 * extension modules must also be ejectable (require.cache cleanup),
 * we use plain require() + a simple registry rather than LazyModuleLoader.
 *
 * The tradeoff: no NestJS DI tree for the extension module (they receive
 * AppContext via the static forApp(ctx) factory), but full cache control
 * for clean unloads.
 */
@Injectable()
export class DynamicModuleLoader implements OnModuleDestroy {
  private readonly logger = new Logger(DynamicModuleLoader.name);
  private readonly loaded = new Map<string, LoadedApp>();

  constructor(@Optional() private readonly processRuntime?: ProcessRuntimeService) {}

  /**
   * Load an app's backend module.
   * Expects the module entry to export a static `forApp(ctx: AppContext)` factory
   * that returns an object with tool provider instances; async factories are awaited.
   * `options.runtime === 'process'`：在独立子进程中加载（MC09），父进程侧的 context 作为宿主上下文。
   */
  async load(
    appId: string,
    entryAbsPath: string,
    moduleName: string,
    context: AppContext,
    options: LoadOptions = {},
  ): Promise<LoadedApp> {
    if (this.loaded.has(appId)) {
      this.logger.warn(`App ${appId} already loaded; reload requires unload first`);
      return this.loaded.get(appId)!;
    }

    if (options.runtime === 'process') {
      if (!this.processRuntime) throw new Error('Process runtime is not available');
      if (!options.process) throw new Error(`Process spec is required for app ${appId}`);
      const moduleRef = await this.processRuntime.start(options.process, hostContextFromAppContext(context));
      const record: LoadedApp = { appId, entryPath: entryAbsPath, moduleRef, runtime: 'process' };
      this.loaded.set(appId, record);
      this.logger.log(`App ${appId} backend started in a separate process`);
      return record;
    }

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(entryAbsPath);
    const defaultExport = mod.default ?? mod;
    const ModClass = mod[moduleName]
      ?? (defaultExport?.name === moduleName ? defaultExport : undefined);
    if (typeof ModClass?.forApp !== 'function') {
      throw new Error(`Backend export ${moduleName} must provide static forApp(ctx)`);
    }
    const moduleRef = await ModClass.forApp(context);

    const record: LoadedApp = { appId, entryPath: entryAbsPath, moduleRef, runtime: 'in-process' };
    this.loaded.set(appId, record);
    this.logger.log(`App ${appId} backend module loaded from ${entryAbsPath}`);
    return record;
  }

  /**
   * Unload an app's backend module and evict it from require.cache.
   * Invokes the module's onDeactivate(reason) hook exactly once (with timeout)
   * before eviction. Returns requiresRestart: true because Node.js module
   * state may linger in closures.
   */
  async unload(appId: string, reason: AppDeactivateReason = 'uninstall'): Promise<{ requiresRestart: boolean }> {
    const record = this.loaded.get(appId);
    if (!record) return { requiresRestart: false };

    // 先从注册表摘除，保证钩子恰好执行一次
    this.loaded.delete(appId);

    if (record.runtime === 'process') {
      // 独立进程：deactivate、宽限期、SIGTERM、SIGKILL 由 AppProcessHost 按顺序执行；进程退出即彻底清理
      try {
        await this.processRuntime?.stop(appId, reason);
      } catch (err: any) {
        this.logger.error(`Stopping backend process for ${appId} failed: ${err.message}`);
      }
      this.logger.log(`App ${appId} backend process stopped (${reason})`);
      return { requiresRestart: false };
    }

    const hook = (record.moduleRef as { onDeactivate?: (r: AppDeactivateReason) => void | Promise<void> })?.onDeactivate;
    if (typeof hook === 'function') {
      try {
        await this.withTimeout(
          Promise.resolve(hook.call(record.moduleRef, reason)),
          DEACTIVATE_HOOK_TIMEOUT_MS,
          `onDeactivate(${reason}) for ${appId}`,
        );
      } catch (err: any) {
        this.logger.error(`onDeactivate(${reason}) failed for ${appId}: ${err.message}`);
      }
    }

    // Evict all entries under the app's install directory from require.cache
    const dir = path.dirname(record.entryPath);
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(dir)) {
        delete require.cache[key];
      }
    }

    this.logger.log(`App ${appId} backend module unloaded (${reason})`);
    return { requiresRestart: true };
  }

  private withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
      ),
    ]);
  }

  isLoaded(appId: string): boolean {
    return this.loaded.has(appId);
  }

  /**
   * 通知已加载的应用授权状态变化（MC11）：调用模块可选钩子 `onLicenseChange(state)`。
   * 独立进程应用经运行时更新子进程的状态（子进程崩溃重启后仍带最新状态）。未加载时返回 false。
   */
  notifyLicenseChange(appId: string, snapshot: AppLicenseSnapshot): boolean {
    const record = this.loaded.get(appId);
    if (!record) return false;
    if (record.runtime === 'process') {
      this.processRuntime?.updateLicense(appId, snapshot);
      return true;
    }
    const hook = (record.moduleRef as { onLicenseChange?: (state: AppLicenseState) => unknown })?.onLicenseChange;
    if (typeof hook === 'function') {
      Promise.resolve()
        .then(() => hook.call(record.moduleRef, snapshot.state))
        .catch((err: any) => this.logger.warn(`onLicenseChange(${snapshot.state}) for ${appId} failed: ${err?.message ?? err}`));
    }
    return true;
  }

  getModuleRef(appId: string): unknown | undefined {
    return this.loaded.get(appId)?.moduleRef;
  }

  getRuntime(appId: string): LoadedApp['runtime'] | undefined {
    return this.loaded.get(appId)?.runtime;
  }

  async onModuleDestroy() {
    for (const appId of [...this.loaded.keys()]) {
      await this.unload(appId, 'shutdown');
    }
  }
}

// Satisfies import reference without adding a runtime dep
interface OnModuleDestroy { onModuleDestroy(): void | Promise<void>; }
