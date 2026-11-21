'use client';

/**
 * 共享 hook：「应用」入口列表（PC「应用」浮层与移动「应用」标签共用，避免两套过滤漂移）。
 * MC12（T-P-19）：改为调用 GET /api/app-entries。后端按侧栏同一授权规则过滤面板，
 * 按应用与宿主的授权状态隐藏或标记只读，并按 manifest sortOrder 排好序；这里不再重复过滤。
 * 类型与纯函数在 @/lib/app-entries（可单测），此处转出，原有导入路径不变。
 */
import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { getMainUrl } from '@/lib/env';
import type { AppEntry } from '@/lib/app-entries';

export type { AppEntry, AppEntryPanel, AppEntryLicense } from '@/lib/app-entries';
export { appEntryPanelTitle, appDisplayName, appEntryDescription, appReadonlyHint, isReadonlyEntry } from '@/lib/app-entries';

const MAIN_URL = getMainUrl();

export function useAppEntries(): { apps: AppEntry[]; reload: () => void } {
  const { token } = useAuth();
  const [apps, setApps] = useState<AppEntry[]>([]);

  const load = useCallback(() => {
    if (!token) return;
    fetch(`${MAIN_URL}/api/app-entries`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then((data: unknown) => {
        if (!Array.isArray(data)) return;
        setApps((data as AppEntry[]).filter(a => Array.isArray(a?.entryPanels) && a.entryPanels.length > 0));
      })
      .catch(() => {});
  }, [token]);

  useEffect(() => { load(); }, [load]);

  return { apps, reload: load };
}
