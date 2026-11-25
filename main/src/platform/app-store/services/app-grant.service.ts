import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { DbService } from '../../../db/db.service';
import { AppRegistryService } from './app-registry.service';
import type { InvocationPrincipal } from '../runtime/invocation-principal';
import { PERMISSION_GROUPS, PermissionGroup } from '../validators/manifest.schema';

export type GrantLevel = 'none' | 'user' | 'admin';
export type GrantTargetType = 'user' | 'department' | 'role';
export const GRANT_TARGET_TYPES: readonly GrantTargetType[] = ['user', 'role', 'department'];
export const GRANT_LEVELS: readonly GrantLevel[] = ['none', 'user', 'admin'];

/** 已授权对象（MC12「应用权限」页）：name 为空表示对象已删除，界面显示 id */
export interface PermissionGrantTarget {
  id: string;
  name: string | null;
  level: Exclude<GrantLevel, 'none'>;
}

/** 一个权限项及其已授权的用户、角色、部门（listGrantsByTarget） */
export interface PermissionGrantSummary {
  id: string;
  label: { zh: string; en?: string };
  description?: { zh: string; en?: string };
  /** manifest 未写或写了无法识别的值时为 other */
  group: PermissionGroup;
  default?: 'user' | 'admin' | 'none';
  /**
   * 权限项已从 manifest 删除，但库中仍有授权记录。这些记录对未声明权限的面板、handler 与工具仍算作
   * 「持有该应用的授权」，因此照样列出，供管理员撤销（只能撤销，不能新授予）。
   */
  undeclared?: true;
  users: PermissionGrantTarget[];
  roles: PermissionGrantTarget[];
  departments: PermissionGrantTarget[];
}

export interface AppGrant {
  appId: string;
  permissionId: string;
  targetType: GrantTargetType;
  targetId: string;
  level: GrantLevel;
}

@Injectable()
export class AppGrantService {
  private readonly logger = new Logger(AppGrantService.name);

  constructor(
    private readonly db: DbService,
    private readonly registry: AppRegistryService,
  ) {}

  async getGrants(appId: string): Promise<AppGrant[]> {
    const res = await this.db.query(
      `SELECT app_id, permission_id, target_type, target_id, level
       FROM jz_app_grants WHERE app_id = $1`,
      [appId],
    );
    return res.rows.map(r => ({
      appId: r.app_id,
      permissionId: r.permission_id,
      targetType: r.target_type,
      targetId: r.target_id,
      level: r.level,
    }));
  }

  /**
   * MC12（T-P-20）：按权限项汇总已授权的用户、角色、部门，供设置「应用权限」页显示。
   * - 列出 manifest 声明的全部权限项（含未授权的，三个列表为空）；
   * - 已从 manifest 删除但仍有授权记录的权限项带 undeclared 标记排在最后（它们仍赋予应用级访问，须能看到并撤销）；
   * - 按分组顺序（function、operation、scope、field、other）排列，组内保持 manifest 中的先后；
   * - 对象按授权时间排列；不展开角色与部门成员（成员展开见 host.listPermissionHolders）。
   */
  async listGrantsByTarget(appId: string): Promise<PermissionGrantSummary[]> {
    const app = await this.registry.findOne(appId);
    if (!app) throw new NotFoundException(`App ${appId} not found`);

    const groupOrder = new Map<string, number>(PERMISSION_GROUPS.map((g, i) => [g, i]));
    const summaries = new Map<string, PermissionGrantSummary>();
    const declared = (app.manifest?.permissions ?? []).map((p, index) => ({ p, index }));
    for (const { p } of declared) {
      if (summaries.has(p.id)) continue;
      summaries.set(p.id, {
        id: p.id,
        label: p.label,
        ...(p.description ? { description: p.description } : {}),
        group: (p.group && groupOrder.has(p.group) ? p.group : 'other') as PermissionGroup,
        ...(p.default ? { default: p.default } : {}),
        users: [],
        roles: [],
        departments: [],
      });
    }
    const res = await this.db.query(
      `SELECT g.permission_id AS "permissionId", g.target_type AS "targetType", g.target_id AS "targetId", g.level,
              CASE g.target_type
                WHEN 'user' THEN COALESCE(NULLIF(u.name, ''), u.username)
                WHEN 'role' THEN r.name
                ELSE d.name
              END AS "targetName"
       FROM jz_app_grants g
       LEFT JOIN jz_users u ON g.target_type = 'user' AND u.id = g.target_id
       LEFT JOIN jz_roles r ON g.target_type = 'role' AND r.id = g.target_id
       LEFT JOIN jz_departments d ON g.target_type = 'department' AND d.id = g.target_id
       WHERE g.app_id = $1 AND g.level <> 'none'
       ORDER BY g.created_at, g.target_id`,
      [appId],
    );
    const listOf = { user: 'users', role: 'roles', department: 'departments' } as const;
    const undeclared = new Map<string, PermissionGrantSummary>();
    for (const row of res.rows) {
      const key = listOf[row.targetType as GrantTargetType];
      if (!key) continue;
      // 授权对象已被删除（用户/角色/部门不存在）：这一行对谁都不生效，界面上只能把 id 当名字显示。
      // 直接跳过，别把 UUID 摆到授权列表里。存量脏数据由 deleteUser 的级联清理兜住。
      if (!row.targetName) {
        this.logger.warn(`App ${appId} 权限 ${row.permissionId} 指向已删除的 ${row.targetType}:${row.targetId}，已从授权列表跳过`);
        continue;
      }
      let summary = summaries.get(row.permissionId) ?? undeclared.get(row.permissionId);
      if (!summary) {
        summary = {
          id: row.permissionId, label: { zh: row.permissionId }, group: 'other', undeclared: true,
          users: [], roles: [], departments: [],
        };
        undeclared.set(row.permissionId, summary);
      }
      summary[key].push({ id: row.targetId, name: row.targetName ?? null, level: row.level });
    }

    const indexOf = new Map(declared.map(({ p, index }) => [p.id, index]));
    const sorted = [...summaries.values()].sort((a, b) =>
      groupOrder.get(a.group)! - groupOrder.get(b.group)! || indexOf.get(a.id)! - indexOf.get(b.id)!);
    return [...sorted, ...[...undeclared.values()].sort((a, b) => a.id.localeCompare(b.id))];
  }

  async setGrant(grant: AppGrant): Promise<void> {
    const app = await this.registry.findOne(grant.appId);
    if (!app) throw new NotFoundException(`App ${grant.appId} not found`);

    const declared = app.manifest?.permissions?.map(p => p.id) ?? [];
    // 撤销（level none）不要求权限项仍在 manifest 中：升级删掉的权限项留下的授权记录须能撤销（MC12）
    if (!declared.includes(grant.permissionId) && grant.level !== 'none') {
      throw new BadRequestException(`Permission ${grant.permissionId} not declared in manifest`);
    }

    if (grant.level === 'none') {
      await this.db.query(
        `DELETE FROM jz_app_grants
         WHERE app_id=$1 AND permission_id=$2 AND target_type=$3 AND target_id=$4`,
        [grant.appId, grant.permissionId, grant.targetType, grant.targetId],
      );
    } else {
      await this.db.query(
        `INSERT INTO jz_app_grants (app_id, permission_id, target_type, target_id, level)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (app_id, permission_id, target_type, target_id)
         DO UPDATE SET level=$5`,
        [grant.appId, grant.permissionId, grant.targetType, grant.targetId, grant.level],
      );
    }
    // P1 T1.10：双写 jz_resource_grants（resource_type='app'，sub_id 承载 permissionId，P3 统一授权消费）
    await this.mirrorToResourceGrants(grant);
  }

  /** 双写开关：AUTHZ_DUAL_WRITE=0 停止（读路径不依赖新表，停写即回滚） */
  private async mirrorToResourceGrants(grant: AppGrant): Promise<void> {
    if (process.env.AUTHZ_DUAL_WRITE === '0') return;
    try {
      if (grant.level === 'none') {
        await this.db.query(
          `DELETE FROM jz_resource_grants
           WHERE resource_type='app' AND resource_id=$1 AND sub_id=$2 AND target_type=$3 AND target_id=$4`,
          [grant.appId, grant.permissionId, grant.targetType, grant.targetId],
        );
      } else {
        await this.db.query(
          `INSERT INTO jz_resource_grants (resource_type, resource_id, sub_id, target_type, target_id, level, granted_by)
           VALUES ('app',$1,$2,$3,$4,$5,NULL)
           ON CONFLICT (resource_type, resource_id, sub_id, target_type, target_id)
           DO UPDATE SET level=$5`,
          [grant.appId, grant.permissionId, grant.targetType, grant.targetId, grant.level],
        );
      }
    } catch (err: any) {
      // 双写失败不阻断旧表语义（表缺失/约束异常时降级为仅旧表）
      this.logger.warn(`resource_grants dual-write failed for app ${grant.appId}: ${err.message}`);
    }
  }

  async hasPermission(appId: string, permissionId: string, userId: string): Promise<boolean> {
    const res = await this.db.query(
      `SELECT 1 FROM jz_app_grants
       WHERE app_id=$1 AND permission_id=$2 AND target_type='user' AND target_id=$3
         AND level != 'none'
       LIMIT 1`,
      [appId, permissionId, userId],
    );
    return res.rows.length > 0;
  }

  /** True if the user has any non-none grant for the app. */
  async hasAppAccess(appId: string, userId: string): Promise<boolean> {
    return this.hasAppAccessForPrincipal(appId, {
      type: 'user',
      principalId: `user:${userId}`,
      userId,
      roleIds: [],
      departmentIds: [],
      permissions: [],
      scopes: [],
      origin: 'legacy-app-grant',
      issuedAt: Date.now(),
    });
  }

  async hasAppAccessForPrincipal(appId: string, principal: InvocationPrincipal): Promise<boolean> {
    if (!principal.userId) return false;
    const res = await this.db.query(
      `SELECT 1
       FROM jz_app_grants g
       WHERE g.app_id=$1
         AND g.level != 'none'
         AND (
           (g.target_type='user' AND g.target_id=$2)
           OR (g.target_type='role' AND g.target_id = ANY($3::text[]))
           OR (g.target_type='department' AND (
             g.target_id = ANY($4::text[])
             OR g.target_id IN (
               SELECT dm.department_id
               FROM jz_department_members dm
               WHERE dm.user_id=$2
             )
           ))
         )
       LIMIT 1`,
      [appId, principal.userId, [...principal.roleIds], [...principal.departmentIds]],
    );
    return res.rows.length > 0;
  }

  // ── 细粒度权限（PLAT-010）──

  /** manifest 中某 handler（"Class.method"）声明的 required permission，未声明返回 undefined */
  async getRequiredHandlerPermission(appId: string, handler: string): Promise<string | undefined> {
    const app = await this.registry.findOne(appId);
    for (const controller of app?.manifest?.backend?.controllers ?? []) {
      const perm = controller.permissions?.[handler];
      if (perm) return perm;
    }
    return undefined;
  }

  /** manifest 中某 tool 声明的 required permission，未声明返回 undefined */
  async getRequiredToolPermission(appId: string, toolId: string): Promise<string | undefined> {
    const app = await this.registry.findOne(appId);
    for (const tp of app?.manifest?.backend?.toolProviders ?? []) {
      const perm = tp.permissions?.[toolId];
      if (perm) return perm;
    }
    return undefined;
  }

  /**
   * 判定 principal 是否持有某具体 permission。
   * 覆盖 user/role/department 三类 target；无任何匹配授权行时按
   * manifest.permissions[].default 判定（'user' 放行，'admin'/'none'/未设置 fail-closed，
   * sys:admin 由调用方先行直通）。
   */
  async hasPermissionForPrincipal(
    appId: string,
    permissionId: string,
    principal: InvocationPrincipal,
  ): Promise<boolean> {
    if (!principal.userId) return false;
    const res = await this.db.query(
      `SELECT 1
       FROM jz_app_grants g
       WHERE g.app_id=$1
         AND g.permission_id=$2
         AND g.level != 'none'
         AND (
           (g.target_type='user' AND g.target_id=$3)
           OR (g.target_type='role' AND g.target_id = ANY($4::text[]))
           OR (g.target_type='department' AND (
             g.target_id = ANY($5::text[])
             OR g.target_id IN (
               SELECT dm.department_id
               FROM jz_department_members dm
               WHERE dm.user_id=$3
             )
           ))
         )
       LIMIT 1`,
      [appId, permissionId, principal.userId, [...principal.roleIds], [...principal.departmentIds]],
    );
    if (res.rows.length > 0) return true;

    const app = await this.registry.findOne(appId);
    const declared = app?.manifest?.permissions?.find(p => p.id === permissionId);
    return declared?.default === 'user';
  }
}
