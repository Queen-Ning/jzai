import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter } from 'events';

export interface ConfirmFormField {
  key: string;
  label: string;
  type: string;
  required?: boolean;
  default?: any;
  columns?: { key: string; label: string }[];
}

export interface ConfirmRequest {
  confirmId: string;
  toolName: string;
  args: Record<string, any>;
  parameters: { name: string; type: string; required?: boolean; description?: string; label?: string }[];
  confirmForm?: ConfirmFormField[];
  description?: string;
  /**
   * 确认归属的用户（MC04）。设置后只有该用户的回复有效，网关只把请求转发给该用户的会话。
   * 不设置时按旧行为处理：广播给所有进行中的会话，任何回复都有效（兼容旧调用方）。
   */
  userId?: string;
  /** 发起确认的智能体会话；网关只转发给该会话，无头运行据此识别自己的请求 */
  sessionId?: string;
  /** 等待回复的毫秒数，默认 DEFAULT_CONFIRM_TIMEOUT_MS；超时后以 confirm_timeout 拒绝 */
  timeoutMs?: number;
}

/** 确认请求默认等待 300 秒 */
export const DEFAULT_CONFIRM_TIMEOUT_MS = 300_000;
/** 超时拒绝的错误消息（调用方据此区分「用户取消」与「超时」） */
export const CONFIRM_TIMEOUT = 'confirm_timeout';
/** 用户取消的错误消息 */
export const CONFIRM_CANCELLED = 'user_cancelled';

interface PendingConfirm {
  resolve: (args: any) => void;
  reject: (err: Error) => void;
  userId?: string;
  timer: ReturnType<typeof setTimeout>;
}

@Injectable()
export class ConfirmationBridgeService {
  private readonly logger = new Logger(ConfirmationBridgeService.name);
  private pending = new Map<string, PendingConfirm>();
  /** Gateway listens on this emitter for 'confirm_request' / 'confirm_timeout' events */
  readonly events = new EventEmitter();

  /**
   * Request user confirmation for tool args.
   * Emits 'confirm_request' on this.events and returns a Promise that resolves
   * when the user confirms (with possibly edited args), or rejects on cancel ('user_cancelled')
   * or timeout ('confirm_timeout'; a 'confirm_timeout' event is emitted as well).
   */
  requestConfirmation(request: ConfirmRequest): Promise<Record<string, any>> {
    const timeoutMs = request.timeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;
    this.logger.log(
      `Requesting confirmation: ${request.confirmId} for tool ${request.toolName}`
      + `${request.userId ? ` (user ${request.userId})` : ''}, timeout ${timeoutMs}ms`,
    );

    // 先注册 pending 再广播：同步应答器（定时任务 headless 自动拒绝）立即可查
    const promise = new Promise<Record<string, any>>((resolve, reject) => {
      const timer = setTimeout(() => this.expire(request.confirmId), timeoutMs);
      timer.unref?.();
      this.pending.set(request.confirmId, { resolve, reject, userId: request.userId, timer });
    });
    this.events.emit('confirm_request', { ...request, timeoutMs });
    return promise;
  }

  /**
   * Handle a reply to a confirmation request.
   * replierId 为回复者的用户 id：请求带 userId 时必须一致，否则忽略回复（请求保持挂起）。
   * Returns true if the confirmId was found and handled.
   */
  handleReply(confirmId: string, confirmed: boolean, editedArgs?: Record<string, any>, replierId?: string): boolean {
    const entry = this.pending.get(confirmId);
    if (!entry) {
      this.logger.warn(`No pending confirmation for: ${confirmId}`);
      return false;
    }
    if (entry.userId && entry.userId !== replierId) {
      this.logger.warn(`Ignored reply for ${confirmId}: replier ${replierId ?? '(unknown)'} is not the owner`);
      return false;
    }
    this.pending.delete(confirmId);
    clearTimeout(entry.timer);
    if (confirmed) {
      this.logger.log(`Confirmed: ${confirmId}`);
      entry.resolve(editedArgs || {});
    } else {
      this.logger.log(`Cancelled: ${confirmId}`);
      entry.reject(new Error(CONFIRM_CANCELLED));
    }
    return true;
  }

  /** 挂起中的确认数（测试与诊断用） */
  pendingCount(): number {
    return this.pending.size;
  }

  private expire(confirmId: string): void {
    const entry = this.pending.get(confirmId);
    if (!entry) return;
    this.pending.delete(confirmId);
    this.logger.warn(`Confirmation timed out: ${confirmId}`);
    this.events.emit('confirm_timeout', { confirmId });
    entry.reject(new Error(CONFIRM_TIMEOUT));
  }
}
