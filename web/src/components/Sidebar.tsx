'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useI18n } from '@/i18n';
import { getMainUrl } from '@/lib/env';
import type { SidebarPanel } from '@/hooks/useSidebar';
import { useAppEntries, appEntryPanelTitle, appDisplayName, appEntryDescription, appReadonlyHint } from '@/hooks/useAppEntries';

const MAIN_URL = getMainUrl();

function PanelIcon({ icon, size = 28 }: { icon: string; size?: number }) {
  if (icon.startsWith('img:')) {
    const src = icon.slice(4);
    return <img src={src} alt="" width={size} height={size} className="rounded-sm object-cover" />;
  }
  if (icon.startsWith('app:')) {
    const parts = icon.slice(4).split(':');
    const appId = parts[0];
    const assetPath = parts.slice(1).join(':');
    return <img src={`/api/app-store/${appId}/asset/${assetPath}`} alt="" width={size} height={size} className="rounded-sm object-cover" onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />;
  }
  return <>{icon}</>;
}

interface SidebarProps {
  active: string;
  onNavigate: (id: string) => void;
  panels: SidebarPanel[];
  onCustomize?: () => void;
}

export default function Sidebar({ active, onNavigate, panels, onCustomize }: SidebarProps) {
  const { t, locale } = useI18n();
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const [appMenuOpen, setAppMenuOpen] = useState(false);
  const [appMenuPos, setAppMenuPos] = useState<{ top: number; left: number; anchorBottom: number }>({ top: 0, left: 0, anchorBottom: 0 });
  const { apps: installedApps } = useAppEntries();
  const popoverRef = useRef<HTMLDivElement>(null);
  const appMenuRef = useRef<HTMLDivElement>(null);

  const handleGroupClick = useCallback((groupName: string, e: React.MouseEvent) => {
    if (openGroup === groupName) { setOpenGroup(null); return; }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setPopoverPos({ top: rect.top, left: rect.right + 4 });
    setOpenGroup(groupName);
  }, [openGroup]);

  // Close popover on outside click
  useEffect(() => {
    if (!openGroup && !appMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpenGroup(null);
      }
      if (appMenuRef.current && !appMenuRef.current.contains(e.target as Node)) {
        setAppMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [openGroup, appMenuOpen]);

  // 应用菜单自适应：宽高由内容撑开（上限为内容区尺寸，见弹出层 style）；
  // 弹出层以底部与「应用」按钮对齐（top = 按钮底边 − 实际高度）；内容过高时
  // 顶部贴内容区上缘、向下延伸。内容变化（应用异步加载）时重新定位。
  useEffect(() => {
    if (!appMenuOpen || !appMenuRef.current) return;
    const height = appMenuRef.current.offsetHeight;
    setAppMenuPos(pos => {
      const top = Math.max(8, pos.anchorBottom - height);
      return top !== pos.top ? { ...pos, top } : pos;
    });
  }, [appMenuOpen, installedApps.length]);

  const visiblePanels = panels.filter(p => p.visible && p.id !== 'cfg');
  const cfgPanel = panels.find(p => p.id === 'cfg');
  const appsPanel = visiblePanels.find(p => p.id === 'apps');

  // Split into groups and ungrouped (apps is rendered separately as a launcher menu)
  const groups: { name: string; items: SidebarPanel[] }[] = [];
  const ungrouped: SidebarPanel[] = [];

  for (const p of visiblePanels) {
    if (p.id === 'apps') continue;
    // APP 面板只允许从「应用」菜单进入，不占用一级导航位（数据仍保留在 panels 中供 agentId 查找与自定义弹窗卸载）
    if (p.sourceAppId) continue;
    if (p.groupName) {
      let g = groups.find(g => g.name === p.groupName);
      if (!g) { g = { name: p.groupName, items: [] }; groups.push(g); }
      g.items.push(p);
    } else {
      ungrouped.push(p);
    }
  }

  const btnClass = (isActive: boolean) =>
    `flex flex-col items-center gap-0.5 py-2.5 rounded-lg text-[10px] transition-all w-full ${
      isActive
        ? 'bg-indigo-50 text-indigo-600 font-medium'
        : 'text-gray-700 hover:bg-gray-100 hover:text-gray-900'
    }`;

  /** Three-tier name resolution: platform i18n key → nameI18n[locale] → panel.name */
  const panelName = (p: SidebarPanel) => {
    const key = `nav.panel.${p.id}`;
    const translated = t(key);
    if (translated !== key) return translated;
    if (p.nameI18n) {
      const lang = locale.startsWith('zh') ? 'zh' : 'en';
      return p.nameI18n[lang] ?? p.nameI18n['zh'] ?? p.nameI18n['en'] ?? p.name;
    }
    return p.name;
  };

  const renderButton = (item: SidebarPanel) => (
    <button key={item.id} onClick={() => { onNavigate(item.id); setOpenGroup(null); }} className={btnClass(active === item.id)}>
      <span className="text-xl leading-none"><PanelIcon icon={item.icon} /></span>
      {panelName(item)}
    </button>
  );

  const groupHasActive = (g: { items: SidebarPanel[] }) => g.items.some(p => active === p.id);

  return (
    <div className="w-[54px] bg-white border-r border-gray-200 flex flex-col shrink-0 select-none relative z-40">
      {/* Logo → 关闭全部面板，回全屏对话页 */}
      <div className="py-3 flex justify-center border-b border-gray-200 cursor-pointer" onClick={() => onNavigate('chat')}>
        <img src="/logo.png" alt={t('nav.brand')} className="w-9 h-9 object-contain" />
      </div>

      <nav className="flex-1 flex flex-col gap-1 p-1.5 pt-3 overflow-y-auto">
        {/* Chat — always first（关闭全部面板、回全屏对话页） */}
        <button onClick={() => onNavigate('chat')} className={btnClass(active === 'chat')}>
          <span className="text-xl leading-none"><PanelIcon icon="img:/icons/chat.svg" /></span>
          {t('nav.chat')}
        </button>

        {/* Groups — rendered as a single icon button with popover */}
        {groups.map(g => (
          <div key={g.name}>
            <button
              onClick={(e) => handleGroupClick(g.name, e)}
              className={btnClass(groupHasActive(g) || openGroup === g.name)}
            >
              <span className="relative text-xl leading-none">
                <PanelIcon icon={g.items[0].icon} />
                <span className="absolute -bottom-0.5 -right-1.5 text-[7px] bg-gray-400 text-white rounded-sm px-0.5 leading-tight">
                  {g.items.length}
                </span>
              </span>
              {g.name}
            </button>
          </div>
        ))}

        {/* Group popover — fixed position, rendered outside nav flow */}
        {openGroup && (() => {
          const g = groups.find(g => g.name === openGroup);
          if (!g) return null;
          return (
            <div ref={popoverRef} className="fixed bg-white border border-gray-200 rounded-lg shadow-lg py-1 z-50 min-w-[120px]"
              style={{ top: popoverPos.top, left: popoverPos.left }}>
              <div className="text-[10px] text-gray-400 px-3 py-1">{g.name}</div>
              {g.items.map(item => (
                <button
                  key={item.id}
                  onClick={() => { onNavigate(item.id); setOpenGroup(null); }}
                  className={`w-full text-left px-3 py-2 flex items-center gap-2 text-sm hover:bg-gray-50 ${
                    active === item.id ? 'text-indigo-600 bg-indigo-50' : 'text-gray-600'
                  }`}
                >
                  <span><PanelIcon icon={item.icon} size={16} /></span>
                  {panelName(item)}
                </button>
              ))}
            </div>
          );
        })()}

        {/* Ungrouped panels */}
        {ungrouped.map(renderButton)}

        {/* Apps launcher menu */}
        {appsPanel && (
          <div>
            <button
              onClick={(e) => {
                if (appMenuOpen) { setAppMenuOpen(false); return; }
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                // 初始先放在按钮处；打开后由上方 effect 按实际高度把底部对齐到按钮底边
                setAppMenuPos({ top: rect.top, left: rect.right + 4, anchorBottom: rect.bottom });
                setAppMenuOpen(true);
              }}
              className={btnClass(appMenuOpen)}
            >
              <span className="text-xl leading-none"><PanelIcon icon={appsPanel.icon} /></span>
              {panelName(appsPanel)}
            </button>
          </div>
        )}

        {appMenuOpen && (() => {
          const activeApps = installedApps;
          const panelTitle = (p: { id: string; name?: { zh?: string; en?: string } }) => appEntryPanelTitle(p, locale);
          return (
            <div ref={appMenuRef} className="fixed bg-white border border-gray-200 rounded-xl shadow-xl z-50 p-3 w-auto min-w-[280px] overflow-y-auto"
              style={{
                top: appMenuPos.top,
                left: appMenuPos.left,
                // 尺寸随内容撑开，但不超出内容区（弹出层 left 起至视口右缘，留 8px 边距）；
                // 最多四列：4×卡片最小宽 210 + 3×间距 10 + 2×内边距 12，第 5 张卡片起换行；高度超出时滚动
                maxWidth: Math.min(window.innerWidth - appMenuPos.left - 8, 4 * 210 + 3 * 10 + 2 * 12),
                maxHeight: window.innerHeight - 16,
              }}>
              <div className="text-[10px] text-gray-400 px-1 pb-2">{panelName(appsPanel!)}</div>
              {activeApps.length === 0 ? (
                <div className="px-3 py-2 text-xs text-gray-400">暂无可用的应用</div>
              ) : (
                <div className="flex flex-wrap gap-2.5">
                  {activeApps.map(app => {
                    const readonlyHint = appReadonlyHint(app);
                    return (
                    <div key={app.appId} className="flex-1 min-w-[210px] max-w-full bg-white border border-gray-200 rounded-lg p-2.5">
                      {/* APP 分组头（灰底标题区）；MC12：授权只读期内显示「只读」标记 */}
                      <div className="flex items-baseline gap-1.5 -mx-2.5 -mt-2.5 px-3.5 py-2 mb-1.5 bg-gray-50 border-b border-gray-200 rounded-t-lg" title={app.appId}>
                        <span className="text-xs font-semibold text-gray-800 truncate">{appDisplayName(app.name, app.appId)}</span>
                        <span className="text-[10px] text-gray-400 shrink-0">v{app.version}</span>
                        {readonlyHint && (
                          <span className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-1 shrink-0" title={readonlyHint}>只读</span>
                        )}
                      </div>
                      {/* 功能入口（一个 APP 可多个） */}
                      <div className="flex flex-wrap gap-1">
                        {app.entryPanels.map(panel => (
                          <button
                            key={`${app.appId}-${panel.id}`}
                            onClick={() => { onNavigate(panel.id); setAppMenuOpen(false); }}
                            className={`flex items-center gap-1.5 px-2 py-1.5 rounded-md text-sm hover:bg-gray-100 transition-all ${
                              active === panel.id ? 'text-indigo-600 bg-gray-100' : 'text-gray-600'
                            }`}
                            title={appEntryDescription(app, locale)}
                          >
                            <span className="shrink-0"><PanelIcon icon={panel.icon || '📦'} size={16} /></span>
                            <span className="truncate max-w-[140px]">{panelTitle(panel)}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })()}

        <div className="flex-1" />

        {/* Settings — always at bottom */}
        {cfgPanel && renderButton(cfgPanel)}

        {/* Customize button */}
        {onCustomize && (
          <button onClick={onCustomize} className="flex flex-col items-center gap-0.5 py-2 rounded-lg text-[10px] text-gray-600 hover:bg-gray-100 hover:text-gray-900 transition-all" title={t('nav.customizeSidebar')}>
            <span className="text-sm leading-none">⋯</span>
          </button>
        )}
      </nav>
    </div>
  );
}
