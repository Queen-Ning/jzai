import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
// 值导入（非 import type）：构造函数参数装饰器需要运行期元数据才能被 Nest DI 解析
import { AgentRegistryService } from '../../agent/core/agent-registry.service';
import { ResourceAccessService } from '../authz/resource-access.service';
import { createUserPrincipal } from '../app-store/runtime/invocation-principal';
import { hostAppIdOf, isAppUsable, licenseStateOf } from '../app-store/app-state';
import type { AppLicenseSnapshot } from '../app-store/runtime/process/protocol';
import { DbService } from '../../db/db.service';
import { WorkspaceService } from '../../workspace/workspace.service';
import * as fs from 'fs';

const SEED_PANELS = [
  { id: 'cw',            name: 'AI员工',    icon: 'img:/icons/coworker.svg',    permission: 'cw:view',        isBuiltin: false, sortOrder: 2, category: 'builtin', agentId: null },
  { id: 'dashboard',     name: '数据仪表',  icon: 'img:/icons/dashboard.svg',   permission: 'nav:dashboard',  isBuiltin: false, sortOrder: 3, category: 'builtin', agentId: 'data_master' },
  { id: 'skills',        name: '技能',      icon: 'img:/icons/skills.svg',      permission: 'nav:skills',     isBuiltin: false, sortOrder: 5, category: 'builtin', agentId: 'skill_master' },
  { id: 'connectors',    name: '连接',      icon: 'img:/icons/connectors.svg',  permission: 'nav:connectors', isBuiltin: false, sortOrder: 6, category: 'builtin', agentId: 'connector_master' },
  { id: 'agents',        name: '智能体',    icon: 'img:/icons/agents.svg',      permission: 'nav:agents',     isBuiltin: false, sortOrder: 7, category: 'system',  agentId: null },
  { id: 'apps',          name: '应用',      icon: 'img:/icons/apps.svg',        permission: 'nav:apps',       isBuiltin: false, sortOrder: 8, category: 'builtin', agentId: null },
  { id: 'cfg',           name: '设置',      icon: '⚙',                          permission: 'nav:settings',   isBuiltin: true,  sortOrder: 9, category: 'system',  agentId: null },
];

/**
 * 面板授权判定（侧栏与「应用」入口共用，MC12：两处同一规则，避免入口与可打开的面板不一致）。
 * 要求外层查询别名 jz_panels 为 p，$1 为 userId；结果列 g.level 非空即有授权。
 */
const PANEL_GRANT_LATERAL = `-- P1 T1.10：双表判定——旧 jz_app_grants UNION ALL 新 jz_resource_grants(resource_type='panel')
         -- sub_id 语义：'' = 整面板授权；非空 = 该面板某 permission 条目授权
         LEFT JOIN LATERAL (
           SELECT g2.level FROM (
             SELECT g.level FROM jz_app_grants g
             WHERE g.app_id = p.source_app_id
               AND g.level != 'none'
               AND (p.permission IS NULL OR g.permission_id = p.permission)
               AND (
                 (g.target_type = 'user' AND g.target_id = $1)
                 OR (g.target_type = 'role' AND g.target_id IN (SELECT u.role_id FROM jz_users u WHERE u.id = $1))
                 OR (g.target_type = 'department' AND g.target_id IN (
                   SELECT dm.department_id FROM jz_department_members dm WHERE dm.user_id = $1
                 ))
               )
             UNION ALL
             SELECT rg.level FROM jz_resource_grants rg
             WHERE rg.resource_type = 'panel'
               AND rg.resource_id = p.id
               AND rg.level != 'none'
               AND (rg.sub_id = '' OR p.permission IS NULL OR rg.sub_id = p.permission)
               AND (
                 (rg.target_type = 'user' AND rg.target_id = $1)
                 OR (rg.target_type = 'role' AND rg.target_id IN (SELECT u.role_id FROM jz_users u WHERE u.id = $1))
                 OR (rg.target_type = 'department' AND rg.target_id IN (
                   SELECT dm.department_id FROM jz_department_members dm WHERE dm.user_id = $1
                 ))
               )
           ) g2
           LIMIT 1
         ) g ON TRUE`;

/** JSONB 多语言字段：对象原样返回；旧数据为字符串时按中文；JSON 文本先解析 */
function asI18n(value: unknown): Record<string, string> | null {
  if (value == null || value === '') return null;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object') return parsed as Record<string, string>;
    } catch { /* 普通字符串 */ }
    return { zh: value };
  }
  return typeof value === 'object' ? (value as Record<string, string>) : null;
}

/** 「应用」入口里的一个功能（面板），MC12 */
export interface AppEntryPanelItem {
  id: string;
  name: Record<string, string>;
  icon: string;
  entryComponent: string;
  sortOrder: number;
  mobile?: { supported: boolean; entryComponent?: string; layout?: 'full' | 'sheet' };
}

/** 「应用」入口里的一个应用卡片（GET /api/app-entries），MC12 */
export interface AppEntryItem {
  appId: string;
  name: Record<string, string> | null;
  version: string;
  description: Record<string, string> | null;
  /** 只读期内为 readonly（应用自身或托管应用的宿主授权到期但仍在只读期）；到期且不在只读期的应用不返回 */
  license: { state: 'valid' | 'readonly'; readonlyUntil: string | null };
  /** 只读的来源：self 为应用自身授权，host 为宿主授权；valid 时不返回 */
  readonlyCause?: 'self' | 'host';
  /** 托管应用的宿主（manifest.tags 含 hosted-by:X） */
  hostAppId?: string;
  entryPanels: AppEntryPanelItem[];
}

export interface SidebarItem {
  id: string;
  name: string;
  icon: string;
  visible: boolean;
  groupName: string;
  sortOrder: number;
  isBuiltin: boolean;
  category: string;
  sourceAppId?: string;
  agentId?: string;
  uninstallable: boolean;
  nameI18n?: Record<string, string>;
  entryComponent?: string;
  keepAlive?: boolean;
  messageSchema?: string;
  appVersion?: string;
}

export interface AppPanelSpec {
  id: string;
  name: Record<string, string>;
  icon?: string;
  groupName?: string;
  sortOrder?: number;
  permission?: string;
  entryComponent?: string;
  agentId?: string;
  keepAlive?: boolean;
  messageSchema?: string;
  /** P4 移动端声明（manifest panels[].mobile 原样存 JSONB） */
  mobile?: { supported: boolean; entryComponent?: string; layout?: 'full' | 'sheet' };
}

@Injectable()
export class PanelService implements OnModuleInit {
  private readonly logger = new Logger(PanelService.name);

  constructor(
    private readonly db: DbService,
    private readonly workspace: WorkspaceService,
    // @Optional：spec 直构只传 db；面板配对智能体的名称/图标仅用于前端显示
    @Optional() private readonly agents?: AgentRegistryService,
    // @Optional：spec 直构不接线时保持旧行为（配对智能体不透出过滤）
    @Optional() private readonly access?: ResourceAccessService,
  ) {}

  async onModuleInit() {
    await this.seedPanels();
  }

  private async seedPanels() {
    for (const p of SEED_PANELS) {
      await this.db.query(
        `INSERT INTO jz_panels (id, name, icon, permission, is_builtin, sort_order, category, agent_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO UPDATE SET
           name = $2, icon = $3, permission = $4,
           category = $7, agent_id = $8`,
        [p.id, p.name, p.icon, p.permission, p.isBuiltin, p.sortOrder, p.category, p.agentId],
      );
    }
    // Remove deprecated panels（kb：企业心智入口已迁入企业WIKI APP，U10）
    await this.db.query(`DELETE FROM jz_panels WHERE id IN ('dash', 'distill', 'users', 'kb')`).catch(() => {});
    await this.db.query(`DELETE FROM jz_user_sidebar WHERE panel_id IN ('distill', 'users', 'kb')`).catch(() => {});
    this.logger.log(`Seeded ${SEED_PANELS.length} panels`);
  }

  async listPanels() {
    const { rows } = await this.db.query(
      'SELECT id, name, icon, permission, is_builtin as "isBuiltin", sort_order as "sortOrder" FROM jz_panels ORDER BY sort_order',
    );
    return rows;
  }

  async getUserSidebar(userId: string, permissions: string[]): Promise<SidebarItem[]> {
    const isAdmin = permissions.includes('sys:admin');
    const hasAppTable = await this.appTableExists();

    let rows: any[];
    if (hasAppTable) {
      const { rows: r } = await this.db.query(
        `SELECT p.id, p.name, p.icon, p.permission,
                p.is_builtin as "isBuiltin", p.sort_order as "defaultOrder",
                p.category, p.source_app_id as "sourceAppId",
                p.agent_id as "agentId", p.uninstallable,
                p.name_i18n as "nameI18n",
                p.entry_component as "entryComponent",
                p.keep_alive as "keepAlive",
                p.message_schema as "messageSchema",
                p.mobile_config as "mobile",
                a.version as "appVersion",
                a.manifest->'tags' as "appTags",
                COALESCE(us.visible, TRUE) as "visible",
                COALESCE(us.group_name, '') as "groupName",
                COALESCE(us.sort_order, p.sort_order) as "sortOrder",
                us.custom_name as "customName",
                us.custom_icon as "customIcon",
                g.level AS "grantRole"
         FROM jz_panels p
         LEFT JOIN jz_user_sidebar us ON us.panel_id = p.id AND us.user_id = $1
         ${PANEL_GRANT_LATERAL}
         LEFT JOIN jz_installed_apps a ON a.app_id = p.source_app_id
         -- MC11/MC12：授权到期但仍在只读期的应用照常可打开（只读由应用自己执行），否则「应用」入口会点开空白
         WHERE (p.source_app_id IS NULL OR a.status = 'active'
                OR (a.status = 'license_expired' AND a.license_readonly_until > now()))
         ORDER BY COALESCE(us.sort_order, p.sort_order)`,
        [userId],
      );
      rows = await this.dropPanelsOfUnusableHosts(r);
    } else {
      const { rows: r } = await this.db.query(
        `SELECT p.id, p.name, p.icon, p.permission,
                p.is_builtin as "isBuiltin", p.sort_order as "defaultOrder",
                p.category, p.source_app_id as "sourceAppId",
                p.agent_id as "agentId", p.uninstallable,
                p.name_i18n as "nameI18n",
                p.entry_component as "entryComponent",
                p.keep_alive as "keepAlive",
                p.message_schema as "messageSchema",
                COALESCE(us.visible, TRUE) as "visible",
                COALESCE(us.group_name, '') as "groupName",
                COALESCE(us.sort_order, p.sort_order) as "sortOrder",
                us.custom_name as "customName",
                us.custom_icon as "customIcon",
                g.level AS "grantRole"
         FROM jz_panels p
         LEFT JOIN jz_user_sidebar us ON us.panel_id = p.id AND us.user_id = $1
         ${PANEL_GRANT_LATERAL}
         ORDER BY COALESCE(us.sort_order, p.sort_order)`,
        [userId],
      );
      rows = r;
    }

    // 配对智能体按可见性透出：普通用户不可见的 agent（如 connector_master，meta 'none'）不带出
    // agentId/名称/图标——前端据此不并入聊天选择器、打开面板也不自动切换（修"普通用户可与连接大师对话"）。
    // meta 缺失的未纳管 agent（APP 动态 agent）保持旧行为放行。
    const hiddenAgents = new Set<string>();
    if (!isAdmin && this.access) {
      const agentIds = [...new Set(rows.map((r: any) => r.agentId).filter(Boolean))] as string[];
      if (agentIds.length > 0) {
        const [uRows, dRows] = await Promise.all([
          this.db.query(`SELECT role_id FROM jz_users WHERE id = $1`, [userId]),
          this.db.query(`SELECT department_id FROM jz_department_members WHERE user_id = $1`, [userId]),
        ]);
        const principal = createUserPrincipal({
          id: userId,
          roleId: uRows.rows[0]?.role_id,
          departmentIds: dRows.rows.map((d: any) => d.department_id),
          permissions,
        }, 'http:sidebar');
        await Promise.all(agentIds.map(async id => {
          if (!(await this.access!.canViewOrUnmanaged('agent', id, principal))) hiddenAgents.add(id);
        }));
      }
    }

    return rows
      .filter((r: any) => {
        if (r.category === 'third_party') {
          // 三方面板：管理员走 grant 或 sys:admin 均可；普通用户必须有 grant
          return isAdmin || !!r.grantRole;
        }
        if (isAdmin) return true;
        return !r.permission || permissions.includes(r.permission);
      })
      .map((r: any) => ({
        id: r.id,
        name: r.customName || r.name,
        icon: r.customIcon || r.icon,
        visible: r.visible,
        groupName: r.groupName,
        sortOrder: r.sortOrder,
        isBuiltin: r.isBuiltin,
        category: r.category ?? 'builtin',
        sourceAppId: r.sourceAppId ?? undefined,
        agentId: r.agentId && !hiddenAgents.has(r.agentId) ? r.agentId : undefined,
        uninstallable: !!r.uninstallable,
        nameI18n: r.nameI18n ?? undefined,
        entryComponent: r.entryComponent ?? undefined,
        keepAlive: !!r.keepAlive,
        messageSchema: r.messageSchema ?? undefined,
        mobile: r.mobile ? (typeof r.mobile === 'string' ? JSON.parse(r.mobile) : r.mobile) : undefined,
        appVersion: r.appVersion ?? undefined,
        // 配对智能体显示元数据（仅 name/icon，不含 soul/提示词）：
        // 前端在"当前智能体"徽标等处需要显示名，但该智能体可能不在用户可授权列表中（面板配对服务智能体）
        ...(r.agentId && !hiddenAgents.has(r.agentId) && this.agents?.get(r.agentId)
          ? { agentName: this.agents.get(r.agentId)!.name, agentIcon: this.agents.get(r.agentId)!.icon }
          : {}),
      }));
  }

  /**
   * 「应用」入口（MC12，T-P-19）：PC「应用」浮层与移动「应用」标签的数据源。
   * - 可见性与侧栏相同（PANEL_GRANT_LATERAL；管理员不看授权），只取有入口组件的第三方面板，避免点开空白；
   * - 应用授权有效或在只读期内才返回，只读期内带只读标记；
   * - 托管应用（tags 含 hosted-by:X）随宿主：宿主未安装、不在 active 或只读期内时不返回；宿主只读时带只读标记；
   * - 应用按安装时间排列；面板按 manifest sortOrder 升序，相同时按 manifest 中的先后；
   * - 不返回配对智能体：入口只用于显示与打开，打开后切换智能体仍按侧栏数据（侧栏已按智能体可见性处理），
   *   因此不调用侧栏的配对智能体可见性查询。
   */
  async getUserAppEntries(userId: string, permissions: string[], now = Date.now()): Promise<AppEntryItem[]> {
    if (!(await this.appTableExists())) return [];
    const isAdmin = permissions.includes('sys:admin');

    const { rows: appRows } = await this.db.query(
      `SELECT a.app_id AS "appId", a.name, a.version, a.status,
              a.license_readonly_until AS "licenseReadonlyUntil",
              a.manifest->'tags' AS tags,
              a.manifest->'description' AS description,
              a.manifest->'panels' AS "manifestPanels"
       FROM jz_installed_apps a
       WHERE a.status IN ('active', 'license_expired')
       ORDER BY a.installed_at`,
    );
    const states = new Map<string, AppLicenseSnapshot>();
    for (const a of appRows) states.set(a.appId, licenseStateOf(a, now));

    const cards: AppEntryItem[] = [];
    const panelOrder = new Map<string, number>();
    for (const a of appRows) {
      const own = states.get(a.appId)!;
      if (own.state === 'expired') continue;
      const hostAppId = hostAppIdOf(a.tags);
      const host = hostAppId ? states.get(hostAppId) : undefined;
      // 宿主未安装、处于升级或失败等状态（不在 states 中），或到期且不在只读期：托管应用不显示
      if (hostAppId && (!host || host.state === 'expired')) continue;

      const ownUntil = own.state === 'readonly' ? own.readonlyUntil : null;
      const hostUntil = host?.state === 'readonly' ? host.readonlyUntil : null;
      const until = [ownUntil, hostUntil]
        .filter((u): u is string => !!u)
        .sort((x, y) => new Date(x).getTime() - new Date(y).getTime())[0] ?? null;
      const card: AppEntryItem = {
        appId: a.appId,
        name: asI18n(a.name),
        version: a.version,
        description: asI18n(a.description),
        license: until ? { state: 'readonly', readonlyUntil: until } : { state: 'valid', readonlyUntil: null },
        ...(until ? { readonlyCause: ownUntil ? 'self' as const : 'host' as const } : {}),
        ...(hostAppId ? { hostAppId } : {}),
        entryPanels: [],
      };
      cards.push(card);
      const manifestPanels: any[] = Array.isArray(a.manifestPanels) ? a.manifestPanels : [];
      manifestPanels.forEach((mp, i) => { if (mp?.id) panelOrder.set(`${a.appId}\u0000${mp.id}`, i); });
    }
    if (cards.length === 0) return [];

    const { rows: panelRows } = await this.db.query(
      `SELECT p.id, p.name, p.icon, p.permission,
              p.sort_order AS "sortOrder",
              p.source_app_id AS "sourceAppId",
              p.name_i18n AS "nameI18n",
              p.entry_component AS "entryComponent",
              p.mobile_config AS "mobile",
              g.level AS "grantRole"
       FROM jz_panels p
       ${PANEL_GRANT_LATERAL}
       WHERE p.category = 'third_party' AND p.source_app_id = ANY($2::text[])`,
      [userId, cards.map(c => c.appId)],
    );

    const byApp = new Map(cards.map(c => [c.appId, c]));
    for (const p of panelRows) {
      const card = byApp.get(p.sourceAppId);
      if (!card || !p.entryComponent) continue;
      if (!isAdmin && !p.grantRole) continue;
      const mobile = p.mobile ? (typeof p.mobile === 'string' ? JSON.parse(p.mobile) : p.mobile) : undefined;
      card.entryPanels.push({
        id: p.id,
        name: asI18n(p.nameI18n) ?? { zh: p.name },
        icon: p.icon ?? '',
        entryComponent: p.entryComponent,
        sortOrder: Number(p.sortOrder ?? 100),
        ...(mobile ? { mobile } : {}),
      });
    }
    const indexOf = (appId: string, panelId: string) => panelOrder.get(`${appId}\u0000${panelId}`) ?? Number.MAX_SAFE_INTEGER;
    for (const card of cards) {
      card.entryPanels.sort((x, y) =>
        x.sortOrder - y.sortOrder
        || indexOf(card.appId, x.id) - indexOf(card.appId, y.id)
        || x.id.localeCompare(y.id));
    }
    return cards.filter(c => c.entryPanels.length > 0);
  }

  async listPanelsByCategory(category: string) {
    const { rows } = await this.db.query(
      `SELECT id, name, icon, permission, is_builtin as "isBuiltin", sort_order as "sortOrder",
              category, source_app_id as "sourceAppId", agent_id as "agentId",
              uninstallable, name_i18n as "nameI18n"
       FROM jz_panels WHERE category = $1 ORDER BY sort_order`,
      [category],
    );
    return rows;
  }

  async registerAppPanel(panel: AppPanelSpec, appId: string): Promise<void> {
    const nameZh = panel.name?.zh ?? panel.name?.en ?? '';
    const nameEn = panel.name?.en ?? nameZh;
    await this.db.query(
      `INSERT INTO jz_panels
         (id, name, icon, permission, is_builtin, sort_order, category,
          source_app_id, agent_id, uninstallable, entry_component, name_i18n, keep_alive, message_schema,
          mobile_config)
       VALUES ($1,$2,$3,$4,FALSE,$5,'third_party',$6,$7,TRUE,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO UPDATE SET
         name=$2, icon=$3, permission=$4, sort_order=$5,
         source_app_id=$6, agent_id=$7, entry_component=$8, name_i18n=$9, keep_alive=$10, message_schema=$11,
         mobile_config=$12`,
      [
        panel.id, nameZh,
        panel.icon ?? '',
        panel.permission ?? null,
        panel.sortOrder ?? 100,
        appId,
        panel.agentId ?? null,
        panel.entryComponent ?? null,
        JSON.stringify(panel.name),
        panel.keepAlive ?? false,
        panel.messageSchema ?? null,
        panel.mobile ? JSON.stringify(panel.mobile) : null,
      ],
    );
  }

  async removeAppPanels(appId: string): Promise<void> {
    // 必须先取回面板 id 再删：先删 jz_panels 会让清理 jz_user_sidebar 的子查询
    // 永远返回空，重装后用户的显隐/分组/排序覆盖会带着陈旧数据复活。
    const { rows } = await this.db.query(
      `SELECT id FROM jz_panels WHERE source_app_id = $1`,
      [appId],
    );
    if (rows.length > 0) {
      const placeholders = rows.map((_: any, i: number) => `$${i + 1}`).join(', ');
      await this.db.query(
        `DELETE FROM jz_user_sidebar WHERE panel_id IN (${placeholders})`,
        rows.map((r: any) => r.id),
      );
    }
    await this.db.query(`DELETE FROM jz_panels WHERE source_app_id = $1`, [appId]);
  }

  /**
   * MC12（T-P-19）：托管应用（tags 含 hosted-by:X）的面板随宿主 X 显示——宿主未安装、未运行，
   * 或授权到期且不在只读期时去掉，与「应用」入口一致（深链与智能体导航按侧栏数据打开面板）。
   */
  private async dropPanelsOfUnusableHosts(rows: any[], now = Date.now()): Promise<any[]> {
    const hostIds = [...new Set(rows.map(r => hostAppIdOf(r.appTags)).filter((h): h is string => !!h))];
    if (hostIds.length === 0) return rows;
    const { rows: hosts } = await this.db.query(
      `SELECT app_id AS "appId", status, license_readonly_until AS "licenseReadonlyUntil"
       FROM jz_installed_apps WHERE app_id = ANY($1::text[])`,
      [hostIds],
    );
    const usable = new Set(hosts.filter((h: any) => isAppUsable(h, now)).map((h: any) => h.appId));
    return rows.filter(r => {
      const host = hostAppIdOf(r.appTags);
      return !host || usable.has(host);
    });
  }

  /** 检查 jz_installed_apps 表是否已存在（L1 阶段该表不存在） */
  private async appTableExists(): Promise<boolean> {
    try {
      const { rows } = await this.db.query(
        `SELECT to_regclass('public.jz_installed_apps') AS tbl`,
      );
      return rows[0]?.tbl != null;
    } catch {
      return false;
    }
  }

  async getSystemPanelIds(panelIds: string[]): Promise<string[]> {
    if (panelIds.length === 0) return [];
    const placeholders = panelIds.map((_, i) => `$${i + 1}`).join(', ');
    const { rows } = await this.db.query(
      `SELECT id FROM jz_panels WHERE id IN (${placeholders}) AND category = 'system'`,
      panelIds,
    );
    return rows.map((r: { id: string }) => r.id);
  }

  async saveUserSidebar(userId: string, items: { panelId: string; visible: boolean; groupName: string; sortOrder: number; customName?: string; customIcon?: string }[]) {
    // Delete existing and re-insert
    await this.db.query('DELETE FROM jz_user_sidebar WHERE user_id = $1', [userId]);
    for (const item of items) {
      await this.db.query(
        `INSERT INTO jz_user_sidebar (user_id, panel_id, visible, group_name, sort_order, custom_name, custom_icon)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [userId, item.panelId, item.visible, item.groupName || '', item.sortOrder, item.customName || null, item.customIcon || null],
      );
    }
  }

  async resetUserSidebar(userId: string) {
    await this.db.query('DELETE FROM jz_user_sidebar WHERE user_id = $1', [userId]);
  }

  // ===== Shortcuts =====

  async getUserShortcuts(userId: string, permissions: string[]): Promise<any[]> {
    const { rows } = await this.db.query(
      'SELECT id, name, icon, type, target, sort_order as "sortOrder" FROM jz_shortcuts WHERE user_id = $1 ORDER BY sort_order',
      [userId],
    );
    if (rows.length === 0) {
      return this.getDefaultShortcuts(permissions);
    }
    if (rows.length === 1 && rows[0].id === '__empty__') {
      return [];
    }
    return rows;
  }

  private async getDefaultShortcuts(permissions: string[]): Promise<any[]> {
    const { rows } = await this.db.query(
      'SELECT id, name, icon, permission FROM jz_panels WHERE is_builtin = FALSE ORDER BY sort_order',
    );
    const isAdmin = permissions.includes('sys:admin');
    return rows
      .filter((r: any) => !r.permission || permissions.includes(r.permission) || isAdmin)
      .map((r: any, i: number) => ({
        id: r.id, name: r.name, icon: r.icon, type: 'panel', target: r.id, sortOrder: i,
      }));
  }

  async saveUserShortcuts(userId: string, items: { id: string; name: string; icon: string; type: string; target: string; sortOrder: number }[]) {
    await this.db.query('DELETE FROM jz_shortcuts WHERE user_id = $1', [userId]);
    if (items.length === 0) {
      await this.db.query(
        'INSERT INTO jz_shortcuts (id, user_id, name, icon, type, target, sort_order) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        ['__empty__', userId, '__empty__', '', 'marker', '__empty__', 0],
      );
      return;
    }
    for (const item of items) {
      await this.db.query(
        'INSERT INTO jz_shortcuts (id, user_id, name, icon, type, target, sort_order) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [item.id, userId, item.name, item.icon, item.type, item.target, item.sortOrder],
      );
    }
  }

  async resetUserShortcuts(userId: string) {
    await this.db.query('DELETE FROM jz_shortcuts WHERE user_id = $1', [userId]);
  }

  // ===== Suggestions =====

  async getUserSuggestions(userId: string): Promise<{ text: string }[]> {
    const filePath = this.workspace.getUserFilePath(userId, 'suggestions.json');

    // Check cache (valid for 24h)
    if (fs.existsSync(filePath)) {
      try {
        const stat = fs.statSync(filePath);
        const ageMs = Date.now() - stat.mtimeMs;
        if (ageMs < 24 * 60 * 60 * 1000) {
          return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        }
      } catch {}
    }

    // Generate from recent messages
    const suggestions = await this.generateSuggestions(userId);
    if (suggestions.length > 0) {
      fs.writeFileSync(filePath, JSON.stringify(suggestions, null, 2), 'utf-8');
    }
    return suggestions;
  }

  saveUserSuggestions(userId: string, items: { text: string }[]) {
    const filePath = this.workspace.getUserFilePath(userId, 'suggestions.json');
    fs.writeFileSync(filePath, JSON.stringify(items, null, 2), 'utf-8');
  }

  clearUserSuggestions(userId: string) {
    // Write empty array (not delete) so getUserSuggestions reads cache instead of regenerating
    const filePath = this.workspace.getUserFilePath(userId, 'suggestions.json');
    fs.writeFileSync(filePath, '[]', 'utf-8');
  }

  private async generateSuggestions(userId: string): Promise<{ text: string }[]> {
    // Get user messages from the last 2 days
    const { rows } = await this.db.query(
      `SELECT content FROM jz_messages m
       JOIN jz_sessions s ON s.id = m.session_id
       WHERE s.user_id = $1 AND m.role = 'user' AND m.created_at > NOW() - INTERVAL '2 days'
       ORDER BY m.created_at DESC LIMIT 50`,
      [userId],
    );

    if (rows.length === 0) return [];

    // Extract short, distinct questions/commands by frequency analysis
    const replyPatterns = /^(是的?|好的?|对的?|嗯+|ok|yes|no|不[是了]?|确认|取消|继续|请继续|可以|行|没问题|明白|知道了|谢谢|感谢|直接录入|先调整数据|\d{1,2})$/i;
    const seen = new Map<string, number>();
    for (const row of rows) {
      const text = (row.content || '').trim();
      if (!text || text.length > 30 || text.startsWith('[附件')) continue;
      // Normalize: strip leading/trailing punctuation
      const normalized = text.replace(/^[，。？！、]+|[，。？！、]+$/g, '').trim();
      if (normalized.length < 2) continue;
      // Skip reply-type messages (confirmations, short responses)
      if (replyPatterns.test(normalized)) continue;
      if (normalized.length < 5 && !/[？?]/.test(normalized)) continue;
      seen.set(normalized, (seen.get(normalized) || 0) + 1);
    }

    // Sort by frequency, take top 3
    const sorted = [...seen.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([text]) => ({ text }));

    // If not enough unique messages, take the most recent distinct ones
    if (sorted.length < 3) {
      const recent: { text: string }[] = [];
      const usedTexts = new Set(sorted.map(s => s.text));
      for (const row of rows) {
        const text = (row.content || '').trim();
        if (!text || text.length > 30 || text.startsWith('[附件') || usedTexts.has(text)) continue;
        const norm = text.replace(/^[，。？！、]+|[，。？！、]+$/g, '').trim();
        if (norm.length < 2 || replyPatterns.test(norm)) continue;
        if (norm.length < 5 && !/[？?]/.test(norm)) continue;
        usedTexts.add(text);
        recent.push({ text });
        if (sorted.length + recent.length >= 3) break;
      }
      sorted.push(...recent);
    }

    return sorted;
  }
}
