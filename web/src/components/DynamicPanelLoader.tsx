'use client';

import React, { Suspense, useMemo, Component, ErrorInfo, ReactNode } from 'react';
import * as ReactDOM from 'react-dom';
import { toast } from 'sonner';
import { isValidDeepLinkRoute } from '@/lib/deep-link';

/** 面板经 sdk.nav.open 请求打开另一个面板（MC06）；page.tsx 监听，移动端映射到 jianzhi:mobile-open-panel */
export const OPEN_PANEL_EVENT = 'jianzhi:open-panel';
export interface OpenPanelDetail {
  panelId: string;
  route?: string | null;
  /** 发起的面板 id */
  from?: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class PanelLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PanelLoadError';
  }
}

// ---------------------------------------------------------------------------
// SDK runtime (minimal — full version in app-sdk-runtime.ts)
// ---------------------------------------------------------------------------

/**
 * 宿主 SDK 版本：2 起共享 react-dom（MC05，面板 SDK 的 react-dom-shim 据此检查宿主是否过旧）。
 */
const HOST_SDK_VERSION = 2;

function ensureSdkGlobal() {
  if (typeof window === 'undefined') return;
  const current = (window as any).__JZ_SDK__;
  if (current && Number(current.sdkVersion) >= HOST_SDK_VERSION) return;
  (window as any).__JZ_SDK__ = {
    ...(current ?? {}),
    react: React,
    reactDom: ReactDOM,
    sdkVersion: HOST_SDK_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Skeleton fallback
// ---------------------------------------------------------------------------

function PanelSkeleton() {
  return (
    <div className="h-full w-full flex items-center justify-center">
      <div className="animate-pulse flex flex-col gap-3 w-48">
        <div className="h-4 bg-gray-200 rounded w-3/4" />
        <div className="h-4 bg-gray-200 rounded w-full" />
        <div className="h-4 bg-gray-200 rounded w-5/6" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Error boundary
// ---------------------------------------------------------------------------

interface ErrorBoundaryProps {
  panelName: string;
  children: ReactNode;
}
interface ErrorBoundaryState {
  error: Error | null;
}

class PanelErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[DynamicPanelLoader] ${this.props.panelName} error:`, error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="h-full flex flex-col items-center justify-center gap-3 text-sm text-gray-500 p-6">
          <p className="font-medium text-red-500">应用面板加载失败</p>
          <p className="text-xs text-gray-400 max-w-xs text-center break-all">
            {this.state.error.message}
          </p>
          <button
            className="text-xs text-blue-500 hover:underline"
            onClick={() => this.setState({ error: null })}
          >
            重试
          </button>
          <details className="text-xs text-gray-400 max-w-xs">
            <summary className="cursor-pointer">详细信息</summary>
            <pre className="mt-1 whitespace-pre-wrap break-all">{this.state.error.stack}</pre>
          </details>
        </div>
      );
    }
    return this.props.children;
  }
}

// ---------------------------------------------------------------------------
// Uninstalled tombstone
// ---------------------------------------------------------------------------

function UninstalledTombstone({ panelName }: { panelName: string }) {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-2 text-sm text-gray-400 p-6">
      <p className="font-medium">「{panelName}」应用已卸载</p>
      <p className="text-xs">该面板对应的扩展包已被移除，相关功能不再可用。</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface ExtPanelProps {
  initialData?: unknown;
  onMessage?: (msg: unknown) => void;
  sdk?: unknown;
  /** 面板内路由（深链 ?r= 或 sdk.nav.open 传入，MC06）；没有时为 null */
  route?: string | null;
}

/** 面板 → Agent 结构化消息（与 main/src/assets/sdk/types/panel.d.ts 的 AgentMessage 对齐） */
export interface PanelAgentMessage {
  text: string;
  context?: Record<string, unknown>;
}

export interface DynamicPanelSpec {
  id: string;
  name: string;
  sourceAppId: string;
  entryComponent: string;
  version: string;
  keepAlive?: boolean;
  status?: string;
}

interface DynamicPanelLoaderProps {
  panel: DynamicPanelSpec;
  initialData?: unknown;
  onMessage?: (msg: unknown) => void;
  /** 面板经 sdk.agent.send() 发出的结构化消息，由宿主路由到绑定 Agent 的会话 */
  onAgentMessage?: (msg: PanelAgentMessage) => void | Promise<void>;
  /** 面板内路由（MC06），作为 route 属性传给面板 */
  route?: string | null;
  /** 面板经 sdk.nav.setRoute() 更新自身路由；宿主据此写地址栏（replaceState） */
  onRouteChange?: (route: string) => void;
}

const MAIN_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

export function DynamicPanelLoader({ panel, initialData, onMessage, onAgentMessage, route, onRouteChange }: DynamicPanelLoaderProps) {
  if (panel.status === 'uninstalled') {
    return <UninstalledTombstone panelName={panel.name} />;
  }

  const entryBasename = panel.entryComponent.split('/').pop() ?? panel.entryComponent;
  const url = `${MAIN_URL}/api/app-store/apps/${panel.sourceAppId}/assets/${panel.entryComponent}?v=${panel.version}`;

  const Comp = useMemo(
    () =>
      React.lazy(async (): Promise<{ default: React.ComponentType<ExtPanelProps> }> => {
        ensureSdkGlobal();
        // Dynamic ESM import with cache-busting via version query param
        const mod = await import(/* webpackIgnore: true */ url) as any;
        if (!mod.default) {
          throw new PanelLoadError(`应用面板 ${panel.sourceAppId}/${entryBasename} 缺少默认导出`);
        }
        return { default: mod.default };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [url],
  );

  // 每面板独立的 sdk 对象：共享 react 实例 + 受宿主路由约束的 agent 通道 + 宿主导航与提示（MC06）
  const sdk = useMemo(() => ({
    ...((typeof window !== 'undefined' ? (window as any).__JZ_SDK__ : undefined) ?? { react: React }),
    agent: {
      send: async (msg: PanelAgentMessage) => {
        if (!msg || typeof msg.text !== 'string' || !msg.text.trim()) return;
        await onAgentMessage?.({ text: msg.text, context: msg.context });
      },
    },
    nav: {
      /** 打开另一个面板（可带面板内路由）；面板不存在或无权访问时宿主提示 */
      open: (panelId: string, nextRoute?: string) => {
        if (typeof panelId !== 'string' || !panelId) return;
        if (nextRoute !== undefined && !isValidDeepLinkRoute(nextRoute)) {
          console.warn(`[DynamicPanelLoader] ${panel.id}: sdk.nav.open 的路由须为不超过 512 个字符的字符串`);
          return;
        }
        const detail: OpenPanelDetail = { panelId, route: nextRoute ?? null, from: panel.id };
        window.dispatchEvent(new CustomEvent(OPEN_PANEL_EVENT, { detail }));
      },
      /** 更新本面板的路由，宿主写入地址栏（不新增历史记录） */
      setRoute: (nextRoute: string) => {
        if (!isValidDeepLinkRoute(nextRoute)) {
          console.warn(`[DynamicPanelLoader] ${panel.id}: sdk.nav.setRoute 的路由须为不超过 512 个字符的字符串`);
          return;
        }
        onRouteChange?.(nextRoute);
      },
    },
    /** 宿主提示（右上角）：type 为 success、error，其他为普通提示 */
    toast: (message: string, opts?: { type?: 'info' | 'success' | 'error' }) => {
      const text = String(message ?? '').slice(0, 300);
      if (!text) return;
      if (opts?.type === 'success') toast.success(text);
      else if (opts?.type === 'error') toast.error(text);
      else toast.message(text);
    },
  }), [onAgentMessage, onRouteChange, panel.id]);

  return (
    <PanelErrorBoundary panelName={panel.name}>
      <Suspense fallback={<PanelSkeleton />}>
        <Comp initialData={initialData} onMessage={onMessage} sdk={sdk} route={route ?? null} />
      </Suspense>
    </PanelErrorBoundary>
  );
}
