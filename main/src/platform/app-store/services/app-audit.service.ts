import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../../db/db.service';

export type AuditAction =
  | 'install' | 'uninstall' | 'upgrade'
  | 'grant_change' | 'config_update' | 'status_change'
  | 'dev_mcp_call' | 'dev_token_issue' | 'dev_token_revoke'
  // MC07：办理人在见智中执行待办快捷动作（只记任务、动作与结果，不记填写内容）
  | 'inbox_action'
  // MC14：开发 MCP prompts/get（只记提示名称，不记参数值）
  | 'dev_mcp_prompt_get'
  // MC10：主台启动时退役旧号首方应用
  | 'retire_legacy_first_party'
  // MC02：首方门面 appstore:host（app_id 为调用方，detail 记目标）
  | 'host_list_hosted_apps' | 'host_uninstall_app' | 'host_get_app_permissions'
  | 'host_get_user_profile' | 'host_list_permission_holders'
  // 44 T-S3-09：流程审批升级时取用户的上级
  | 'host_list_user_managers'
  // MC11：订阅授权与运行联动
  | 'license_import' | 'license_readonly' | 'license_deactivated' | 'license_restored' | 'license_restore_blocked'
  // MC16：隔离插件运行平台（app_id 为首方宿主，detail 记托管应用、制品与摘要；不记插件输入输出与密钥）
  | 'sandbox_prepare' | 'sandbox_prepare_rejected' | 'sandbox_invoke' | 'sandbox_bridge_denied'
  | 'sandbox_http' | 'sandbox_dispose' | 'sandbox_runtime';

export interface AuditEntry {
  id: string;
  appId: string;
  action: AuditAction;
  actorId: string | null;
  payload: Record<string, unknown>;
  createdAt: Date;
}

@Injectable()
export class AppAuditService {
  private readonly logger = new Logger(AppAuditService.name);

  constructor(private readonly db: DbService) {}

  /**
   * 递归脱敏：key 含 secret/password/credential/apiKey/authorization/token（tokenId 除外）
   * 或值形如 jzdev_* Bearer token 时替换为 [redacted]。
   */
  private redact(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(v => this.redact(v));
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = this.isSensitiveKey(k) ? '[redacted]' : this.redact(v);
      }
      return out;
    }
    if (typeof value === 'string' && /^jzdev_[0-9a-f]+$/i.test(value)) return '[redacted]';
    return value;
  }

  private isSensitiveKey(key: string): boolean {
    const k = key.toLowerCase();
    if (/tokenid/.test(k)) return false;
    return /secret|password|credential|api[-_]?key|authorization|token/.test(k);
  }

  async log(
    appId: string,
    action: AuditAction,
    actorId: string | null,
    payload: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO jz_app_audit_log (app_id, action, actor_id, detail)
         VALUES ($1, $2, $3, $4)`,
        [appId, action, actorId, JSON.stringify(this.redact(payload))],
      );
    } catch (err) {
      // Audit log failures must not interrupt main flows
      this.logger.error(`Failed to write audit log for ${appId}/${action}: ${err.message}`);
    }
  }

  async getLogs(appId: string, limit = 100): Promise<AuditEntry[]> {
    const res = await this.db.query(
      `SELECT id, app_id, action, actor_id, detail, created_at
       FROM jz_app_audit_log
       WHERE app_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [appId, limit],
    );
    return res.rows.map(r => ({
      id: r.id,
      appId: r.app_id,
      action: r.action,
      actorId: r.actor_id,
      payload: r.detail,
      createdAt: r.created_at,
    }));
  }
}
