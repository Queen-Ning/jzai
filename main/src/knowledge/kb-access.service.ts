import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';

/**
 * Knowledge-base access control（自 bridge/knowledge 迁入并扩展）：
 * 解析用户可访问的分类 scope 集合与管理员判定。
 *
 * - Admins (sys:admin / kb:admin) 返回 'ADMIN_ALL'，不过滤。
 * - 其他用户返回分类 ID 列表（直接授权/部门/工作组，递归子树）。无授权 → 空列表（fail-closed）。
 */
@Injectable()
export class KbAccessService {
  constructor(private readonly db: DbService) {}

  async isAdmin(userId: string): Promise<boolean> {
    const { rows } = await this.db.query(
      `SELECT r.permissions
       FROM jz_users u
       JOIN jz_roles r ON r.id = u.role_id
       WHERE u.id = $1`,
      [userId],
    );
    if (rows.length === 0) return false;
    const permissions: string[] = rows[0].permissions || [];
    return permissions.includes('sys:admin') || permissions.includes('kb:admin');
  }

  /**
   * 返回用户可访问分类及其继承后的角色（写路径用）。
   *
   * - 管理员（sys:admin / kb:admin）→ 'ADMIN_ALL'
   * - 其余用户：user / role / department / workgroup 四类直接授权向下继承到所有子孙分类，
   *   同一分类命中多条授权时取最高角色（admin > editor > viewer）。
   * - 无授权 → 空数组（fail-closed）。
   */
  async getAccessibleScopesWithRole(
    userId: string,
  ): Promise<'ADMIN_ALL' | Array<{ categoryId: string; role: 'viewer' | 'editor' | 'admin' }>> {
    if (await this.isAdmin(userId)) {
      return 'ADMIN_ALL';
    }

    const result = await this.db.query(
      `
      WITH RECURSIVE seeds AS (
        SELECT category_id,
               MAX(CASE role WHEN 'admin' THEN 3 WHEN 'editor' THEN 2 ELSE 1 END) AS rank
        FROM jz_kb_category_access
        WHERE (grantee_type = 'user' AND grantee_id = $1)
           OR (grantee_type = 'role'
               AND grantee_id = (SELECT role_id FROM jz_users WHERE id = $1))
           OR (grantee_type = 'department'
               AND grantee_id IN (SELECT department_id FROM jz_department_members WHERE user_id = $1))
           OR (grantee_type = 'workgroup'
               AND grantee_id IN (SELECT workgroup_id FROM jz_workgroup_members WHERE user_id = $1))
        GROUP BY category_id
      ),
      accessible AS (
        SELECT category_id, rank FROM seeds
        UNION ALL
        SELECT c.id, a.rank
        FROM jz_kb_categories c
        JOIN accessible a ON c.parent_id = a.category_id
      )
      SELECT category_id, MAX(rank) AS rank
      FROM accessible
      GROUP BY category_id
      `,
      [userId],
    );

    return result.rows.map((r: any) => ({
      categoryId: String(r.category_id),
      role: Number(r.rank) >= 3 ? 'admin' : Number(r.rank) === 2 ? 'editor' : 'viewer',
    }));
  }

  /**
   * Return accessible category scopes for a user.
   * ADMIN_ALL means no filtering should be applied.
   */
  async getAccessibleScopesForUser(userId: string): Promise<string[] | 'ADMIN_ALL'> {
    if (await this.isAdmin(userId)) {
      return 'ADMIN_ALL';
    }

    const result = await this.db.query(
      `
      WITH RECURSIVE accessible AS (
        SELECT DISTINCT category_id
        FROM jz_kb_category_access
        WHERE (grantee_type = 'user' AND grantee_id = $1)
           OR (grantee_type = 'department'
               AND grantee_id IN (SELECT department_id FROM jz_department_members WHERE user_id = $1))
           OR (grantee_type = 'workgroup'
               AND grantee_id IN (SELECT workgroup_id FROM jz_workgroup_members WHERE user_id = $1))
        UNION ALL
        SELECT c.id
        FROM jz_kb_categories c
        JOIN accessible a ON c.parent_id = a.category_id
      )
      SELECT category_id FROM accessible
      `,
      [userId],
    );

    return result.rows.map((r: any) => String(r.category_id));
  }
}
