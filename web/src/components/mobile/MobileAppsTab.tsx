'use client';

/**
 * P4 移动端"应用"TAB。
 * 数据：useAppEntries()（GET /api/app-entries，MC12 已按授权、应用与宿主授权状态过滤并排序）
 * × sidebarPanels（打开面板所需的版本、配对智能体等）——
 * 仅列出 mobile.supported===true 且用户可见的 APP 面板；entryComponent 取
 * mobile.entryComponent ?? PC entryComponent（T4.1 激活链写入）。只读期内的应用带「只读」标记。
 * 挂载复用 DynamicPanelLoader（动态 ESM 与视口无关）；TAB 切换不卸载（keepAlive 语义）。
 */
import { useState, useEffect, useRef } from 'react';
import { useI18n } from '@/i18n';
import { useAppEntries, appEntryPanelTitle, appDisplayName, appReadonlyHint, type AppEntry } from '@/hooks/useAppEntries';
import { DynamicPanelLoader, type PanelAgentMessage } from '@/components/DynamicPanelLoader';

interface SidebarPanelLike {
  id: string;
  name: string;
  sourceAppId?: string | null;
  entryComponent?: string | null;
  agentId?: string | null;
  appVersion?: string | null;
  mobile?: { supported: boolean; entryComponent?: string; layout?: 'full' | 'sheet' } | null;
}

interface Props {
  /** 后端 /api/sidebar 返回（P1 已按 grants/visibility 过滤） */
  panels: SidebarPanelLike[];
  /** 面板经 sdk.agent.send() 发出的消息，路由到绑定 Agent 会话（与 PC 同链路） */
  onPanelAgentMessage?: (panel: { id: string; sourceAppId?: string | null; agentId?: string | null }, msg: PanelAgentMessage) => void | Promise<void>;
}

interface OpenTarget {
  app: AppEntry;
  panel: SidebarPanelLike;
  title: string;
  /** 面板内路由（MC06：深链或 sdk.nav.open 传入，sdk.nav.setRoute 更新） */
  route: string | null;
}

/** 与 Sidebar PanelIcon 同逻辑的迷你实现（img:/app:/emoji 三分支） */
function PanelIcon({ icon, size = 18 }: { icon?: string; size?: number }) {
  if (!icon) return <span>📦</span>;
  if (icon.startsWith('img:')) {
    return <img src={icon.slice(4)} alt="" width={size} height={size} className="rounded-sm object-cover" />;
  }
  if (icon.startsWith('app:')) {
    const parts = icon.slice(4).split(':');
    const appId = parts[0];
    const assetPath = parts.slice(1).join(':');
    return <img src={`/api/app-store/${appId}/asset/${assetPath}`} alt="" width={size} height={size}
      className="rounded-sm object-cover" onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />;
  }
  return <span>{icon}</span>;
}

export default function MobileAppsTab({ panels, onPanelAgentMessage }: Props) {
  const { locale } = useI18n();
  const { apps } = useAppEntries();
  const [open, setOpen] = useState<OpenTarget | null>(null);
  // 应用清单尚未到达时（如首次加载即带深链）暂存打开请求，清单到达后再打开
  const pendingOpenRef = useRef<{ panelId: string; route: string | null } | null>(null);

  // P4/MC06：page.tsx 派发 jianzhi:mobile-open-panel（智能体 navigate、深链、sdk.nav.open）→ 自动打开对应移动面板
  useEffect(() => {
    const tryOpen = (panelId: string, route: string | null): boolean => {
      for (const app of apps) {
        const spec = app.entryPanels.find(p => p.id === panelId);
        const sidebar = panels.find(sp => sp.id === panelId);
        if (spec && sidebar?.mobile?.supported) {
          setOpen({ app, panel: sidebar, title: appEntryPanelTitle(spec, locale), route });
          return true;
        }
      }
      return false;
    };
    if (pendingOpenRef.current && tryOpen(pendingOpenRef.current.panelId, pendingOpenRef.current.route)) {
      pendingOpenRef.current = null;
    }
    const handler = (e: Event) => {
      const { panelId, route } = (e as CustomEvent).detail ?? {};
      if (!panelId) return;
      const nextRoute = typeof route === 'string' ? route : null;
      pendingOpenRef.current = tryOpen(panelId, nextRoute) ? null : { panelId, route: nextRoute };
    };
    window.addEventListener('jianzhi:mobile-open-panel', handler);
    return () => window.removeEventListener('jianzhi:mobile-open-panel', handler);
  }, [apps, panels, locale]);

  // APP × sidebar 可见面板交集，过滤 mobile.supported
  const groups = apps
    .map(app => ({
      app,
      entries: app.entryPanels
        .map(p => ({ spec: p, sidebar: panels.find(sp => sp.id === p.id) }))
        .filter(x => x.sidebar?.mobile?.supported === true && x.sidebar.sourceAppId),
    }))
    .filter(g => g.entries.length > 0);

  return (
    <div className="flex flex-col h-full bg-gray-50">
      {open ? (
        <div className="flex flex-col h-full bg-white">
          <div className="flex items-center gap-2 px-3 h-11 border-b border-gray-200 shrink-0">
            <button onClick={() => setOpen(null)}
              className="text-gray-500 active:bg-gray-100 rounded p-2 -ml-2 text-base">←</button>
            <span className="text-sm font-medium truncate">{open.title}</span>
            {appReadonlyHint(open.app) && (
              <span className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-1 shrink-0">只读</span>
            )}
          </div>
          <div className="flex-1 min-h-0">
            <DynamicPanelLoader
              panel={{
                id: open.panel.id,
                name: open.title,
                sourceAppId: open.panel.sourceAppId!,
                entryComponent: open.panel.mobile?.entryComponent ?? open.panel.entryComponent!,
                version: open.panel.appVersion ?? '0',
              }}
              onAgentMessage={msg => onPanelAgentMessage?.(
                { id: open.panel.id, sourceAppId: open.panel.sourceAppId, agentId: open.panel.agentId },
                msg,
              )}
              route={open.route}
              onRouteChange={nextRoute => setOpen(prev => (prev ? { ...prev, route: nextRoute } : prev))}
            />
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-3 pb-[env(safe-area-inset-bottom)]">
          {groups.length === 0 ? (
            <div className="text-center text-gray-400 py-16">
              <div className="text-3xl mb-2">📦</div>
              <div className="text-xs">暂无支持移动端的应用功能</div>
              <div className="text-[10px] mt-1">（应用需在 manifest 中显式声明 mobile.supported）</div>
            </div>
          ) : (
            <div className="space-y-3">
              {groups.map(({ app, entries }) => (
                <div key={app.appId} className="bg-white border border-gray-200 rounded-lg p-3">
                  <div className="flex items-baseline gap-1.5 mb-2">
                    <span className="text-xs font-semibold text-gray-800 truncate">{appDisplayName(app.name, app.appId)}</span>
                    {app.version && <span className="text-[10px] text-gray-400 shrink-0">v{app.version}</span>}
                    {appReadonlyHint(app) && (
                      <span className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-1 shrink-0">只读</span>
                    )}
                  </div>
                  {appReadonlyHint(app) && (
                    <div className="text-[10px] text-amber-700 -mt-1 mb-2">{appReadonlyHint(app)}</div>
                  )}
                  <div className="grid grid-cols-2 gap-2">
                    {entries.map(({ spec, sidebar }) => (
                      <button
                        key={sidebar!.id}
                        onClick={() => setOpen({ app, panel: sidebar!, title: appEntryPanelTitle(spec, locale), route: null })}
                        className="flex items-center gap-2 px-3 py-2.5 rounded-md border border-gray-200 text-sm text-gray-700 active:bg-gray-100 text-left"
                      >
                        <span><PanelIcon icon={spec.icon} /></span>
                        <span className="truncate">{appEntryPanelTitle(spec, locale)}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
