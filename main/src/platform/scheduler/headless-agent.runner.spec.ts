/**
 * T2.4 单测：HeadlessAgentRunner（无人值守全链路 + confirm 自动应答）+ 会话前缀过滤。
 */
import * as fs from 'fs';
import * as path from 'path';
import { HeadlessAgentRunner } from './headless-agent.runner';
import { ConfirmationBridgeService } from '../../agent/support/confirmation-bridge.service';
import type { TaskRunnerService } from './task-runner.service';

function makeRunner(chunks: any[], opts: { onGen?: (gen: AsyncGenerator<any>) => void; finallyFlag?: { released: boolean } } = {}) {
  const calls: any[] = [];
  const dynamicAgent = {
    processMessage: jest.fn((...args: any[]) => {
      calls.push(args);
      async function* gen(): AsyncGenerator<any> {
        try {
          for (const c of chunks) yield c;
        } finally {
          if (opts.finallyFlag) opts.finallyFlag.released = true;
        }
      }
      const g = gen();
      opts.onGen?.(g);
      return g;
    }),
  } as any;
  const taskRunner = { registerAgentRunner: jest.fn() } as unknown as TaskRunnerService;
  const bridge = new ConfirmationBridgeService();
  const runner = new HeadlessAgentRunner(dynamicAgent, taskRunner, bridge);
  runner.onModuleInit();
  expect(taskRunner.registerAgentRunner).toHaveBeenCalled();
  const agentFn = (taskRunner.registerAgentRunner as jest.Mock).mock.calls[0][0] as any;
  return { runner, calls, bridge, agentFn };
}

const baseTask: any = {
  id: 'task1', name: 't', enabled: true, cron: '0 9 * * *', timezone: 'Asia/Shanghai',
  targetType: 'agent', targetId: 'main', payload: { prompt: '生成晨报' },
  runAsUserId: 'u1', onConfirm: 'reject', timeoutSec: 300, maxRetries: 0,
};

describe('T2.4 HeadlessAgentRunner', () => {
  it('用例1：简单 prompt → success；output 为累积 text_delta；session_id 为 sched_*', async () => {
    const { agentFn } = makeRunner([
      { type: 'text_delta', text: '早上好，' },
      { type: 'tool_call', toolName: 'x' },
      { type: 'text_delta', text: '今日晨报如下。' },
      { type: 'done' },
    ]);
    const result = await agentFn(baseTask, 7);
    expect(result.sessionId).toBe('sched_task1_7');
    expect(result.output).toBe('早上好，今日晨报如下。');
  });

  it('processMessage 收到的 principal 为 system + origin=scheduler（P1 跳过过滤对拍）', async () => {
    const { calls, agentFn } = makeRunner([{ type: 'done' }]);
    await agentFn(baseTask, 1);
    const principal = calls[0][7];
    expect(principal.type).toBe('system');
    expect(principal.origin).toBe('scheduler');
    expect(principal.scopes).not.toContain('confirm:skip_tool'); // reject 模式
  });

  it('用例2：reject 模式——流内发起确认请求 → 自动拒绝（handleReply false），run 正常收尾不挂起', async () => {
    const bridge = new ConfirmationBridgeService();
    const handleSpy = jest.spyOn(bridge, 'handleReply');
    const taskRunner = { registerAgentRunner: jest.fn() } as unknown as TaskRunnerService;
    const dynamicAgent = {
      processMessage: jest.fn(() => (async function* () {
        yield { type: 'text_delta', text: '准备调用工具…' };
        try {
          await bridge.requestConfirmation({
            confirmId: 'c1', toolName: '危险工具', args: {}, parameters: [],
            userId: 'u1', sessionId: 'sched_task1_3',
          });
          yield { type: 'text_delta', text: '[不应到达]' };
        } catch {
          yield { type: 'text_delta', text: '工具被拒绝，改用手动整理。' };
        }
        yield { type: 'done' };
      })()),
    } as any;
    const runner = new HeadlessAgentRunner(dynamicAgent, taskRunner, bridge);
    const agentFn = (taskRunner.registerAgentRunner as jest.Mock).mock.calls[0]?.[0]
      ?? (() => runner.run(baseTask, 3));
    // onModuleInit 已注册则直接用注册的回调
    runner.onModuleInit();
    const fn = (taskRunner.registerAgentRunner as jest.Mock).mock.calls[0][0];
    const result = await fn(baseTask, 3);
    expect(handleSpy).toHaveBeenCalledWith('c1', false, undefined, 'u1');
    expect(result.output).toContain('工具被拒绝');
    expect(result.output).not.toContain('[不应到达]');
  });

  // T-P-04-C08：只拒绝本次运行会话的请求，其他用户交互会话的确认保持挂起
  it('C08：reject 模式只拒绝自己会话的请求；同时段 u2 交互会话的确认保持挂起', async () => {
    const bridge = new ConfirmationBridgeService();
    const taskRunner = { registerAgentRunner: jest.fn() } as unknown as TaskRunnerService;
    let otherConfirm: Promise<unknown> | undefined;
    let otherSettled = false;
    const dynamicAgent = {
      processMessage: jest.fn(() => (async function* () {
        // 同一时段另一用户的交互确认先发出
        otherConfirm = bridge.requestConfirmation({
          confirmId: 'u2-confirm', toolName: '交互工具', args: {}, parameters: [],
          userId: 'u2', sessionId: 'chat-session-u2',
        });
        otherConfirm.then(() => { otherSettled = true; }, () => { otherSettled = true; });
        try {
          await bridge.requestConfirmation({
            confirmId: 'task-confirm', toolName: '危险工具', args: {}, parameters: [],
            userId: 'u1', sessionId: 'sched_task1_5',
          });
        } catch (err: any) {
          yield { type: 'text_delta', text: `拒绝：${err.message}` };
        }
        yield { type: 'done' };
      })()),
    } as any;
    const runner = new HeadlessAgentRunner(dynamicAgent, taskRunner, bridge);
    runner.onModuleInit();
    const fn = (taskRunner.registerAgentRunner as jest.Mock).mock.calls[0][0];
    const result = await fn(baseTask, 5);
    expect(result.output).toBe('拒绝：user_cancelled');
    await new Promise(r => setImmediate(r));
    expect(otherSettled).toBe(false);
    expect(bridge.pendingCount()).toBe(1);
    // u2 自己回复后才完成
    expect(bridge.handleReply('u2-confirm', true, { ok: 1 }, 'u2')).toBe(true);
    await expect(otherConfirm).resolves.toEqual({ ok: 1 });
    expect(bridge.events.listenerCount('confirm_request')).toBe(0);
  });

  // T-P-04-C09：以 runAsUser 作为回复者拒绝成功，运行不等待超时
  it('C09：runAsUser=u1 → 以 u1 回复拒绝成功（handleReply 返回 true），不等超时', async () => {
    const bridge = new ConfirmationBridgeService();
    const replies: boolean[] = [];
    const original = bridge.handleReply.bind(bridge);
    jest.spyOn(bridge, 'handleReply').mockImplementation((...args: Parameters<typeof original>) => {
      const ok = original(...args);
      replies.push(ok);
      return ok;
    });
    const taskRunner = { registerAgentRunner: jest.fn() } as unknown as TaskRunnerService;
    const dynamicAgent = {
      processMessage: jest.fn(() => (async function* () {
        try {
          await bridge.requestConfirmation({
            confirmId: 'c9', toolName: '危险工具', args: {}, parameters: [],
            userId: 'u1', sessionId: 'sched_task1_9', timeoutMs: 60_000,
          });
        } catch (err: any) {
          yield { type: 'text_delta', text: err.message };
        }
        yield { type: 'done' };
      })()),
    } as any;
    const runner = new HeadlessAgentRunner(dynamicAgent, taskRunner, bridge);
    runner.onModuleInit();
    const fn = (taskRunner.registerAgentRunner as jest.Mock).mock.calls[0][0];
    const started = Date.now();
    const result = await fn(baseTask, 9);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(replies).toEqual([true]);
    expect(result.output).toBe('user_cancelled');
    expect(bridge.pendingCount()).toBe(0);
  });

  it('用例3：skip_tool 模式——principal.scopes 含 confirm:skip_tool；reject 应答器未注册', async () => {
    const { calls, bridge, agentFn } = makeRunner([{ type: 'done' }]);
    const listenerBefore = bridge.events.listenerCount('confirm_request');
    await agentFn({ ...baseTask, onConfirm: 'skip_tool' }, 1);
    const principal = calls[0][7];
    expect(principal.scopes).toContain('confirm:skip_tool');
    expect(bridge.events.listenerCount('confirm_request')).toBe(listenerBefore); // 无残留监听
  });

  it('error chunk → run 拒绝且 generator 被显式释放（finally 执行）', async () => {
    const flag = { released: false };
    const { agentFn } = makeRunner(
      [{ type: 'text_delta', text: 'x' }, { type: 'error', error: '模型调用失败' }],
      { finallyFlag: flag },
    );
    await expect(agentFn(baseTask, 1)).rejects.toThrow('模型调用失败');
    expect(flag.released).toBe(true);
  });

  it('用例5：会话列表/计数/复用查询均排除 sched_ 前缀（静态断言）', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../agent/session/session.service.ts'), 'utf-8');
    expect(src.match(/id NOT LIKE .*sched_%/g)!.length).toBeGreaterThanOrEqual(3);
    // 三处：getRecentSession（模板字符串）/ listSessions / countSessions（单行字符串转义引号）
    const recent = src.match(/getRecentSession[\s\S]*?LIMIT 1`/)![0];
    expect(recent).toContain("id NOT LIKE 'sched_%'");
    const list = src.match(/listSessions[\s\S]*?OFFSET \$4'/)![0];
    expect(list).toContain("id NOT LIKE \\'sched_%\\'");
    const count = src.match(/countSessions[\s\S]*?count, 10/)![0];
    expect(count).toContain("id NOT LIKE \\'sched_%\\'");
  });
});
