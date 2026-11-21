
import { Injectable, Inject, Optional, Logger } from '@nestjs/common';
import { ToolProvider, ToolContext, ToolInstance, ToolCatalogEntry, TOOL_PROVIDERS } from './tool-provider.interface';
import { DynamicToolProviderRegistry } from './dynamic-tool-provider.registry';
import { AppGrantService } from '../../platform/app-store/services/app-grant.service';
import { AppConnectionBindingService } from '../../platform/app-store/services/app-connection-binding.service';
import { UserService } from '../../user/user.service';
import {
  InvocationPrincipal,
  InvocationPrincipalInput,
  normalizeInvocationPrincipal,
  principalHasScope,
  principalIsExpired,
} from '../../platform/app-store/runtime/invocation-principal';
import { classifyError, formatToolError } from './tool-error';
import { McpRegistryService } from '../../capability/mcp/mcp-registry.service';
import { CompanionServiceManager } from '../../platform/app-store/runtime/companion-service.manager';
import { ResourceAccessService } from '../../platform/authz/resource-access.service';
import { ResourceGrantService } from '../../platform/authz/resource-grant.service';
import { CONFIRM_TIMEOUT, ConfirmationBridgeService } from '../support/confirmation-bridge.service';
import { randomUUID } from 'crypto';

/** 应用工具人工确认的错误码（MC04），与 FORBIDDEN 等一样放在 details.__error.code */
export const CONFIRM_UNAVAILABLE = 'CONFIRM_UNAVAILABLE';
export const CONFIRM_REJECTED = 'CONFIRM_REJECTED';

/** 确认请求归属：谁来确认、确认框发到哪个会话 */
interface ConfirmContext {
  userId?: string;
  sessionId?: string;
}

/**
 * ToolBridgeService — collects all ToolProviders and builds tool sets for agents.
 * Includes L1 truncation (safety wrapper) for all tool outputs.
 */
@Injectable()
export class ToolBridgeService {
  private readonly logger = new Logger(ToolBridgeService.name);
  private providerMap = new Map<string, ToolProvider>();
  private providerTokenLimits: Record<string, number> = {};
  private piAi: any = null;

  // P0-4: cache ToolInstance Arrays per provider+context to avoid rebuilding on every message
  private toolInstanceCache = new Map<string, { tools: ToolInstance[]; expiry: number }>();
  private static readonly TOOL_CACHE_TTL_MS = 60 * 1000; // 1 minute

  constructor(
    @Optional() @Inject(TOOL_PROVIDERS) private readonly providers: ToolProvider[] = [],
    @Optional() private readonly dynamicRegistry?: DynamicToolProviderRegistry,
    @Optional() private readonly appGrantService?: AppGrantService,
    @Optional() private readonly userService?: UserService,
    @Optional() private readonly connectionBindings?: AppConnectionBindingService,
    @Optional() private readonly mcpRegistry?: McpRegistryService,
    @Optional() private readonly companionManager?: CompanionServiceManager,
    @Optional() private readonly authzAccess?: ResourceAccessService,
    @Optional() private readonly authzGrants?: ResourceGrantService,
    // MC04：应用工具声明 confirm 时由这里统一发起人工确认；未接线（单测直构）时跳过确认并告警一次
    @Optional() private readonly confirmBridge?: ConfirmationBridgeService,
  ) {
    for (const p of (this.providers || [])) {
      for (const id of p.toolIds) {
        this.providerMap.set(id, p);
      }
      if (p.tokenLimits) {
        for (const [toolName, limit] of Object.entries(p.tokenLimits)) {
          this.providerTokenLimits[toolName] = limit;
        }
      }
    }
    this.mcpRegistry?.onChange(() => this.invalidateToolCache('mcp'));
    const dynamicCount = this.dynamicRegistry ? this.dynamicRegistry.getAll().length : 0;
    if (this.providers?.length > 0 || dynamicCount > 0) {
      this.logger.log(`Registered ${this.providers.length} static tool providers (${this.providerMap.size} static tool IDs), ${dynamicCount} dynamic providers`);
    }
  }

  /** Initialize with piAi reference (called from DynamicAgentService.onModuleInit) */
  async init(piAi: any): Promise<void> {
    this.piAi = piAi;
    this.logger.log(`ToolBridgeService initialized (${this.providerMap.size} tool IDs)`);
  }

  invalidateToolCache(toolId?: string): void {
    if (!toolId) {
      this.toolInstanceCache.clear();
      return;
    }
    const provider = this.findProvider(toolId);
    if (!provider) return;
    const prefix = `${provider.toolIds.join(',')}::`;
    for (const key of this.toolInstanceCache.keys()) {
      if (key.startsWith(prefix)) this.toolInstanceCache.delete(key);
    }
  }

  private cacheKeyForProvider(provider: ToolProvider, ctx: ToolContext): string {
    const principal = ctx.principal;
    const identity = principal
      ? [
          principal.type,
          principal.principalId,
          principal.tokenId ?? '',
          principal.expiresAt ?? '',
          principal.roleIds.join(','),
          principal.departmentIds.join(','),
          principal.permissions.join(','),
          principal.scopes.join(','),
        ].join(':')
      : ctx.userId || '';
    return `${provider.toolIds.join(',')}::${identity}::${ctx.userEmail || ''}::${ctx.agentKey || ''}`;
  }

  private async getOrCreateTools(provider: ToolProvider, triggerId: string, ctx: ToolContext): Promise<ToolInstance[]> {
    const ownerApp = this.dynamicRegistry?.getOwnerForProvider(provider);
    const providerCtx = ownerApp && this.connectionBindings
      ? {
          ...ctx,
          connections: this.connectionBindings.createClient(ownerApp, ctx.principal),
        }
      : ctx;
    const key = this.cacheKeyForProvider(provider, providerCtx);
    const cached = this.toolInstanceCache.get(key);
    if (cached && cached.expiry > Date.now()) {
      return cached.tools;
    }

    try {
      const tools = await provider.createTools(providerCtx);
      this.toolInstanceCache.set(key, { tools, expiry: Date.now() + ToolBridgeService.TOOL_CACHE_TTL_MS });
      return tools;
    } catch (err: any) {
      this.logger.warn(`ToolProvider for "${triggerId}" failed: ${err.message}`);
      return [];
    }
  }

  /**
   * Build tools for an agent by tool name list.
   * Resolves each name to a ToolProvider, creates tool instances, and wraps with safety.
   */
  async buildForAgent(
    toolNames: string[],
    ctx: ToolContext,
    maxToolOutputChars?: number,
  ): Promise<ToolInstance[]> {
    const principal = ctx.principal ?? normalizeInvocationPrincipal(ctx.userId, 'legacy-tool-context');
    const fullCtx: ToolContext = {
      ...ctx,
      principal,
      userId: principal?.userId ?? ctx.userId,
      piAi: this.piAi,
    };
    const tools: { tool: ToolInstance; triggerId: string }[] = [];
    const individualTools: string[] = [];
    const individualMcps: string[] = [];

    // Preserve first-appearance order of providers for deterministic deduplication
    const providerOrder: { provider: ToolProvider; triggerId: string }[] = [];
    const seenProviders = new Set<ToolProvider>();
    for (const name of toolNames) {
      if (name.startsWith('tool:')) {
        individualTools.push(name.slice(5));
      } else if (name.startsWith('mcp:')) {
        individualMcps.push(name.slice(4));
      } else {
        const provider = this.findProvider(name);
        if (provider && !seenProviders.has(provider)) {
          seenProviders.add(provider);
          providerOrder.push({ provider, triggerId: name });
        } else if (!provider) {
          this.logger.warn(`Unknown tool: ${name} (no provider registered)`);
        }
      }
    }

    // Create tools in parallel while preserving order for collision resolution
    const createdArrays = await Promise.all(
      providerOrder.map(({ provider, triggerId }) =>
        this.getOrCreateTools(provider, triggerId, fullCtx).then(created =>
          created.map(t => ({ tool: t, triggerId }))
        )
      )
    );
    for (const arr of createdArrays) tools.push(...arr);

    // Load individually selected custom tools (tool:xxx → filter from 'tools' provider)
    if (individualTools.length > 0) {
      const toolsProvider = this.providerMap.get('tools');
      if (toolsProvider) {
        const allCustom = await this.getOrCreateTools(toolsProvider, 'tools', fullCtx);
        for (const t of allCustom.filter(t => individualTools.some(n => t.name === `tool_${n}`))) {
          tools.push({ tool: t, triggerId: 'tools' });
        }
      }
    }

    // Load individually selected MCP servers (mcp:xxx → filter from 'mcp' provider)
    if (individualMcps.length > 0) {
      const mcpProvider = this.providerMap.get('mcp');
      if (mcpProvider) {
        const allMcp = await this.getOrCreateTools(mcpProvider, 'mcp', fullCtx);
        for (const t of allMcp.filter(t => individualMcps.some(n => t.name.startsWith(`mcp_${n}_`)))) {
          tools.push({ tool: t, triggerId: 'mcp' });
        }
      }
    }

    // Deduplicate: first occurrence keeps its name, later ones get prefixed with triggerId
    const seen = new Map<string, number>();
    const deduped: ToolInstance[] = [];
    for (const { tool, triggerId } of tools) {
      if (!seen.has(tool.name)) {
        seen.set(tool.name, deduped.length);
        deduped.push(tool);
      } else {
        const prefixed = `${triggerId}_${tool.name}`;
        this.logger.warn(`Tool name collision: "${tool.name}" (from ${triggerId}) renamed to "${prefixed}"`);
        deduped.push({ ...tool, name: prefixed });
      }
    }

    // P2 运行期兜底：connector/sub-tool 双层过滤（YAML 写死 mcp:x 也封死；system principal 跳过）
    let authzFiltered = await this.filterByConnectorAuthz(deduped, principal);

    // P2 scheduler skip_tool：无人值守下剔除声明 confirm 的工具（LLM 看不到，不会发起确认请求）
    if (principal && principal.origin === 'scheduler' && principal.scopes.includes('confirm:skip_tool')) {
      const before = authzFiltered.length;
      authzFiltered = authzFiltered.filter(t => !t.confirm);
      const removed = before - authzFiltered.length;
      if (removed > 0) this.logger.log(`P2 scheduler skip_tool: 剔除 ${removed} 个 confirm 工具（${principal.principalId}）`);
    }

    // Global safety wrapper: auth + confirm + truncation + error catch
    return this.wrapWithSafety(authzFiltered, principal, maxToolOutputChars, {
      userId: fullCtx.userId,
      sessionId: ctx.sessionId,
    });
  }

  /**
   * P1 buildForAgent 兜底过滤：对解析出的 workspace 连接类工具做
   * 第一层 canView(connector/tool) + 第二层 per-tool visibleSubIds 过滤。
   * 名称按 mcp 注册表已知连接名最长前缀切分（防止连接名含下划线误切）。
   * 剔除项 warn（T1.9 要求）。AUTHZ_ENFORCE=0 或未接线 → 原样返回。
   */
  private async filterByConnectorAuthz(tools: ToolInstance[], principal: InvocationPrincipal | undefined): Promise<ToolInstance[]> {
    const access = this.authzAccess;
    if (!access || !access.isEnforced()) return tools;
    if (!principal) return tools; // legacy 无身份上下文，无法判定，保持旧行为
    if (access.isSystemPrincipal(principal)) return tools;
    if (principal.permissions.includes('sys:admin')) return tools;

    const mapped = tools.map(t => {
      const mcp = this.splitMcpToolName(t.name);
      if (mcp) return { tool: t, kind: 'connector' as const, resId: mcp.conn, subId: mcp.tool };
      if (t.name.startsWith('tool_') && this.toolRegistryHas(t.name.slice(5))) {
        return { tool: t, kind: 'tool' as const, resId: t.name.slice(5) };
      }
      return { tool: t, kind: 'other' as const };
    });

    const connNames = [...new Set(mapped.filter(m => m.kind === 'connector').map(m => m.resId))];
    const toolNames = [...new Set(mapped.filter(m => m.kind === 'tool').map(m => m.resId))];
    const [visibleConnList, visibleToolList] = await Promise.all([
      access.filterVisible('connector', connNames, x => x, principal),
      access.filterVisible('tool', toolNames, x => x, principal),
    ]);
    const visibleConns = new Set(visibleConnList);
    const visibleTools = new Set(visibleToolList);

    // per-conn 缓存防 N+1：仅当用户持有该连接的 grant 时才施加 sub-tool 过滤
    //（default_visibility='all'/owner 可见的连接无子授权概念，全部子工具放行）
    const grantCache = new Map<string, boolean>();
    const subCache = new Map<string, Set<string> | null>();
    const hasAnyGrant = async (conn: string) => {
      if (!this.authzGrants) return false;
      if (!grantCache.has(conn)) grantCache.set(conn, await this.authzGrants.hasGrant('connector', conn, principal));
      return grantCache.get(conn)!;
    };
    const visibleSubs = async (conn: string) => {
      if (!subCache.has(conn)) subCache.set(conn, await this.authzGrants!.visibleSubIds('connector', conn, principal));
      return subCache.get(conn)!;
    };

    const kept: ToolInstance[] = [];
    for (const m of mapped) {
      if (m.kind === 'other') { kept.push(m.tool); continue; }
      if (m.kind === 'tool') {
        if (visibleTools.has(m.resId)) kept.push(m.tool);
        else this.logger.warn(`P1 authz: 剔除未授权工具 tool:${m.resId}（${principal.userId ?? principal.principalId}）`);
        continue;
      }
      if (!visibleConns.has(m.resId)) {
        this.logger.warn(`P1 authz: 剔除未授权连接 mcp:${m.resId} 的工具 ${m.tool.name}（${principal.userId ?? principal.principalId}）`);
        continue;
      }
      if (m.subId && await hasAnyGrant(m.resId)) {
        const subs = await visibleSubs(m.resId);
        if (subs !== null && !subs.has(m.subId)) {
          this.logger.warn(`P1 authz: 剔除未授权子工具 mcp:${m.resId}/${m.subId}（${principal.userId ?? principal.principalId}）`);
          continue;
        }
      }
      kept.push(m.tool);
    }
    return kept;
  }

  /** mcp_<conn>_<tool> 切分：用注册表已知连接名做最长前缀匹配 */
  private splitMcpToolName(name: string): { conn: string; tool: string } | null {
    if (!this.mcpRegistry || !name.startsWith('mcp_')) return null;
    const conns = this.mcpRegistry.getAll().map(m => m.name);
    let best: string | null = null;
    for (const conn of conns) {
      if (name.startsWith(`mcp_${conn}_`) && (best === null || conn.length > best.length)) best = conn;
    }
    if (!best) return null;
    return { conn: best, tool: name.slice(`mcp_${best}_`.length) };
  }

  /** tool_<name> 是否来自 workspace 工具注册表（区分内置/动态 provider 的同名工具） */
  private toolRegistryHas(name: string): boolean {
    // 经 mcpRegistry 之外的注册表不可直接访问；用 provider 形态保守判定：
    // 仅当 'tools' provider 存在时认为 tool_: 前缀工具可能来自 workspace 注册表。
    return this.providerMap.has('tools');
  }

  /** Get catalog for settings UI */
  getCatalog(): ToolCatalogEntry[] {
    const entries: ToolCatalogEntry[] = [];
    for (const p of (this.providers || [])) {
      entries.push(...p.getCatalog());
    }
    for (const p of (this.dynamicRegistry?.getAll() ?? [])) {
      entries.push(...p.getCatalog());
    }
    return entries;
  }

  hasProvider(toolId: string): boolean {
    if (this.providerMap.has(toolId)) return true;
    return this.dynamicRegistry?.getAll().some(p => p.toolIds.includes(toolId)) ?? false;
  }

  getRegisteredToolIds(): string[] {
    const ids = new Set(this.providerMap.keys());
    for (const p of (this.dynamicRegistry?.getAll() ?? [])) {
      for (const id of p.toolIds) ids.add(id);
    }
    return Array.from(ids);
  }

  private findProvider(toolId: string): ToolProvider | undefined {
    const exact = this.providerMap.get(toolId) ?? this.dynamicRegistry?.getAll().find(p => p.toolIds.includes(toolId));
    if (exact) return exact;
    if (toolId.startsWith('mcp_')) return this.providerMap.get('mcp');
    if (toolId.startsWith('tool_')) return this.providerMap.get('tools');
    return undefined;
  }

  // ── Safety wrapper (L1 truncation + error catch) ────────────────────────

  private wrapWithSafety(
    tools: ToolInstance[],
    principalInput?: InvocationPrincipalInput,
    maxToolOutputChars?: number,
    confirmCtx: ConfirmContext = {},
  ): ToolInstance[] {
    const principal = normalizeInvocationPrincipal(principalInput, 'legacy-tool-execution');
    return tools.map(tool => ({
      ...tool,
      execute: async (...args: any[]) => {
        const ownerApp = this.dynamicRegistry?.getOwnerApp(tool.name);
        // MC11：授权到期且不在只读期（只读期内照常转发，由应用自行拒绝写入）
        if (ownerApp && this.dynamicRegistry?.isLicenseBlocked?.(ownerApp)) {
          const message = `APP_LICENSE_EXPIRED: app ${ownerApp} license has expired`;
          return {
            content: [{ type: 'text' as const, text: message }],
            details: { __error: { code: 'APP_LICENSE_EXPIRED', message } },
          };
        }
        if (ownerApp && this.dynamicRegistry?.isDraining(ownerApp)) {
          return {
            content: [{ type: 'text' as const, text: `Conflict: app ${ownerApp} is deactivating` }],
            details: { __error: { code: 'APP_DRAINING', message: `App ${ownerApp} is deactivating` } },
          };
        }
        // PLAT-016：伴随服务运行期不健康 → degraded，工具调用明确报错（不放行产生脏结果）
        if (ownerApp) {
          const degraded = this.companionManager?.isDegraded(ownerApp);
          if (degraded?.degraded) {
            return {
              content: [{ type: 'text' as const, text: `Service Unavailable: ${degraded.reason}` }],
              details: { __error: { code: 'APP_SERVICE_UNHEALTHY', message: degraded.reason ?? 'companion service unhealthy' } },
            };
          }
        }
        if (ownerApp && !(await this.checkToolAccess(ownerApp, principal, tool.name))) {
          return {
            content: [{ type: 'text' as const, text: `Forbidden: no grant for app ${ownerApp}` }],
            details: { __error: { code: 'FORBIDDEN', message: `No grant for app ${ownerApp}` } },
          };
        }
        // MC04：应用工具声明 confirm 时，授权通过后、执行前由用户确认；确认后以返回的参数执行
        if (ownerApp && tool.confirm === true) {
          const confirmed = await this.confirmAppTool(tool, ownerApp, principal, args[1], confirmCtx);
          if (!confirmed.ok) return confirmed.result;
          args = [...args];
          args[1] = confirmed.params;
        }
        try {
          const result = await tool.execute(...args);
          return this.truncateToolResult(result, tool.name, maxToolOutputChars);
        } catch (err: any) {
          // P0-5: classify the exception so the Agent loop and UI can react by error type
          const structured = classifyError(err, tool.name);
          this.logger.warn(`Tool ${tool.name} error [${structured.code}]: ${structured.raw || structured.message}`);
          return {
            content: [{ type: 'text' as const, text: formatToolError(structured) }],
            details: { __error: structured },
          };
        }
      },
    }));
  }

  private warnedNoConfirmBridge = false;

  /**
   * 应用工具的人工确认（MC04）。只有能找到确认人的调用才发起确认：
   * - 用户主体：确认人为该用户，确认框发到所在会话；
   * - 定时任务（system 主体，origin = scheduler）：确认人为 runAsUser，reject 模式由无头运行按会话号自动拒绝；
   * - 开发 MCP、服务主体、其他系统主体与委托调用，以及没有会话号的直接调用：没有可以弹框的人，返回 CONFIRM_UNAVAILABLE。
   * 取消或超时返回 CONFIRM_REJECTED（details 同时带 __confirmCancelled，沿用智能体循环对确认取消的处理）。
   */
  private async confirmAppTool(
    tool: ToolInstance,
    ownerApp: string,
    principal: InvocationPrincipal | undefined,
    params: unknown,
    ctx: ConfirmContext,
  ): Promise<{ ok: true; params: unknown } | { ok: false; result: any }> {
    if (!this.confirmBridge) {
      if (!this.warnedNoConfirmBridge) {
        this.warnedNoConfirmBridge = true;
        this.logger.warn('ConfirmationBridgeService 未接线：应用工具的 confirm 声明被跳过');
      }
      return { ok: true, params };
    }
    const owner = this.confirmOwner(principal, ctx);
    if (!owner) {
      const message = `工具 ${tool.name} 需要用户确认，当前调用方（${principal?.type ?? '无身份'}）无法弹出确认`;
      return {
        ok: false,
        result: {
          content: [{ type: 'text' as const, text: `[${CONFIRM_UNAVAILABLE}] ${message}` }],
          details: { __error: { code: CONFIRM_UNAVAILABLE, message, retryable: false } },
        },
      };
    }
    const args = params && typeof params === 'object' ? params as Record<string, any> : {};
    try {
      const edited = await this.confirmBridge.requestConfirmation({
        confirmId: `app_${tool.name}_${Date.now()}_${randomUUID().slice(0, 8)}`,
        toolName: tool.name,
        args,
        parameters: confirmParametersOf(tool.parameters),
        description: tool.description,
        userId: owner.userId,
        sessionId: owner.sessionId,
      });
      // 前端确认时回传完整参数；回复未带参数（空对象）时沿用原参数
      return { ok: true, params: edited && Object.keys(edited).length > 0 ? edited : args };
    } catch (err: any) {
      const timedOut = err?.message === CONFIRM_TIMEOUT;
      const message = timedOut ? '确认超时，操作已取消' : '用户取消了此操作';
      this.logger.log(`App tool ${tool.name} (${ownerApp}) not confirmed: ${timedOut ? 'timeout' : 'cancelled'}`);
      return {
        ok: false,
        result: {
          content: [{ type: 'text' as const, text: `[${CONFIRM_REJECTED}] ${message}` }],
          details: {
            __error: { code: CONFIRM_REJECTED, message, retryable: false },
            __confirmCancelled: true,
            __userCancelled: !timedOut,
          },
        },
      };
    }
  }

  private confirmOwner(principal: InvocationPrincipal | undefined, ctx: ConfirmContext): Required<ConfirmContext> | null {
    if (!principal || !ctx.sessionId) return null;
    if (principal.type === 'user' && principal.userId) {
      return { userId: principal.userId, sessionId: ctx.sessionId };
    }
    if (principal.type === 'system' && principal.origin === 'scheduler' && ctx.userId) {
      return { userId: ctx.userId, sessionId: ctx.sessionId };
    }
    return null;
  }

  private async checkToolAccess(appId: string, principal?: InvocationPrincipal, toolId?: string): Promise<boolean> {
    if (!principal || principalIsExpired(principal)) return false;
    if (principal.type === 'user' && principal.permissions.includes('sys:admin')) return true;
    if (principal.type === 'system' || principal.type === 'service' || principal.type === 'dev-mcp') {
      return principalHasScope(principal, 'app:invoke')
        || principalHasScope(principal, `app:${appId}:invoke`);
    }
    if (!principal.userId || !this.appGrantService) return false;

    let effectivePrincipal = principal;
    if (this.userService && principal.roleIds.length === 0 && principal.permissions.length === 0) {
      const user = await this.userService.getUser(principal.userId);
      if (!user) return false;
      effectivePrincipal = {
        ...principal,
        roleIds: user.role?.id ? [user.role.id] : [],
        permissions: user.role?.permissions ?? [],
      };
      if (
        effectivePrincipal.type === 'user'
        && effectivePrincipal.permissions.includes('sys:admin')
      ) return true;
    }
    // tool 声明了 required permission 时按细粒度判定，否则回退 app 粒度（PLAT-010）
    if (toolId) {
      const requiredPermission = await this.appGrantService.getRequiredToolPermission(appId, toolId);
      if (requiredPermission) {
        return this.appGrantService.hasPermissionForPrincipal(appId, requiredPermission, effectivePrincipal);
      }
    }
    return this.appGrantService.hasAppAccessForPrincipal(appId, effectivePrincipal);
  }

  /**
   * Direct single-tool invocation — the runtime path of AppContext.tools.call
   * (manifest.usesPlatformTools channel). Goes through the same safety wrapper
   * (auth + truncation + error classification) as agent tool calls.
   * Structured tool errors are re-thrown as exceptions for app code.
   */
  async callTool(
    toolId: string,
    params: unknown,
    principalInput?: InvocationPrincipalInput,
  ): Promise<unknown> {
    const principal = normalizeInvocationPrincipal(principalInput, 'legacy-direct-tool');
    const provider = this.findProvider(toolId);
    if (!provider) throw new Error(`Unknown platform tool: ${toolId}`);
    const created = await this.getOrCreateTools(provider, toolId, {
      principal,
      userId: principal?.userId,
      piAi: this.piAi,
    });
    const matches = created.filter(t => t.name === toolId);
    if (matches.length !== 1) {
      throw new Error(`Tool ${toolId} must resolve to exactly one instance; received ${matches.length}`);
    }
    const [wrapped] = this.wrapWithSafety(matches, principal);
    const result = await wrapped.execute(toolId, params);
    const structured = (result as any)?.details?.__error;
    if (structured) {
      throw new Error(`${structured.code ?? 'TOOL_ERROR'}: ${structured.message ?? structured.raw ?? 'tool failed'}`);
    }
    return result;
  }

  /** L1: Truncate tool results to prevent context overflow. */
  private truncateToolResult(result: any, toolName: string, agentMaxChars?: number): any {
    if (!result?.content) return result;

    const baseLimits: Record<string, number> = {
      document_extract: 20000, read: 20000, ocr: 20000,
      knowledge: 15000, kb_mcp: 15000, web_search: 15000,
      fetch_url: 15000, firecrawl: 15000, web_fetch: 15000,
      bash: 10000,
    };

    // Dynamic registry limits override static provider limits, which override base defaults.
    // Agent-level cap wins if explicitly provided.
    const dynamicLimit = this.dynamicRegistry?.getTokenLimit(toolName);
    let maxChars = agentMaxChars || dynamicLimit || this.providerTokenLimits[toolName] || baseLimits[toolName];
    if (!maxChars) {
      if (toolName.startsWith('mcp_') || toolName.startsWith('tool_')) {
        maxChars = 55000;
      } else {
        maxChars = 20000;
      }
    }

    const textParts = Array.isArray(result.content) ? result.content.filter((c: any) => c.type === 'text') : [];
    for (const part of textParts) {
      if (!part.text || part.text.length <= maxChars) continue;

      const sample = part.text.slice(0, 200);
      if (/[\x00-\x08\x0E-\x1F]/.test(sample) || sample.includes('PK!')) {
        this.logger.warn(`Tool ${toolName}: binary content detected (${part.text.length}ch), filtered`);
        part.text = `工具返回了二进制内容（${part.text.length} 字符），已自动过滤。如需提取文件内容，请使用 document_extract 工具。`;
        continue;
      }

      const origLen = part.text.length;
      const originalText = part.text;
      if (toolName === 'bash') {
        const head = part.text.slice(0, Math.floor(maxChars * 0.7));
        const tail = part.text.slice(-Math.floor(maxChars * 0.3));
        part.text = `${head}\n\n...(中间省略 ${origLen - maxChars} 字符)...\n\n${tail}`;
      } else {
        const firstChar = part.text.trimStart()[0];
        if (firstChar === '{' || firstChar === '[') {
          part.text = this.summarizeData(part.text, maxChars, origLen);
        } else {
          part.text = part.text.slice(0, maxChars) + `\n\n...(截断，原文共 ${origLen} 字符)`;
        }
      }
      // Preserve original full text for programmatic consumers (skill handlers)
      result._raw = originalText;
      this.logger.debug(`Tool ${toolName}: result truncated ${origLen} → ${part.text.length}ch`);
      this.logger.log(`[CTX_METRIC] event=l1_truncate tool=${toolName} original_size=${origLen} truncated_size=${part.text.length} limit=${maxChars}`);
    }
    return result;
  }

  private summarizeData(text: string, maxChars: number, origLen: number): string {
    try {
      const data = JSON.parse(text);
      if (data && typeof data === 'object') {
        // DB query result pattern: { columns: [...], rows: [...], rowCount: N }
        if (Array.isArray(data.rows)) {
          const cols = Array.isArray(data.columns) ? data.columns : (data.rows[0] ? Object.keys(data.rows[0]) : []);
          const totalRows = data.rows.length;
          const sampleRows = data.rows.slice(0, 5);
          const summary = JSON.stringify({ columns: cols, rows: sampleRows, rowCount: data.rowCount ?? totalRows, _summary: `共 ${totalRows} 条数据，已保留前 5 条作为样本` });
          if (summary.length <= maxChars) return summary;
          // Even sample too large — just return metadata
          return JSON.stringify({ columns: cols, rowCount: data.rowCount ?? totalRows, _summary: `共 ${totalRows} 条数据（${origLen} 字符），样本数据过大已省略。字段: ${cols.join(', ')}` });
        }
        // Generic object/array — keep first portion as valid JSON
        if (Array.isArray(data)) {
          const sample = data.slice(0, 5);
          const summary = JSON.stringify(sample);
          if (summary.length <= maxChars) return JSON.stringify({ _items: sample, _summary: `共 ${data.length} 条，已保留前 5 条` });
          return JSON.stringify({ _summary: `数组共 ${data.length} 项（${origLen} 字符），数据过大已省略` });
        }
      }
    } catch { /* not valid JSON — fall through to plain truncation */ }
    return text.slice(0, maxChars) + `\n\n...(截断，原文共 ${origLen} 字符)`;
  }
}

/** 由工具参数的 JSON Schema（TypeBox 或普通对象）生成确认框的参数列表 */
export function confirmParametersOf(
  schema: unknown,
): { name: string; type: string; required?: boolean; description?: string }[] {
  const s = schema as { properties?: Record<string, any>; required?: unknown } | undefined;
  const properties = s && typeof s === 'object' && s.properties && typeof s.properties === 'object' ? s.properties : {};
  const required = new Set(Array.isArray(s?.required) ? (s!.required as string[]) : []);
  return Object.entries(properties).map(([name, prop]) => {
    const type = typeof prop?.type === 'string' ? prop.type : Array.isArray(prop?.type) ? String(prop.type[0]) : 'string';
    const entry: { name: string; type: string; required?: boolean; description?: string } = { name, type };
    if (required.has(name)) entry.required = true;
    if (typeof prop?.description === 'string') entry.description = prop.description;
    return entry;
  });
}
