import { ToolAdapterService } from './tool-adapter.service';

const mockType = {
  Object: (props: any) => ({ type: 'object', properties: props }),
  String: (opts?: any) => ({ type: 'string', ...opts }),
  Number: () => ({ type: 'number' }),
  Boolean: () => ({ type: 'boolean' }),
  Any: () => ({ type: 'any' }),
  Optional: (t: any) => ({ ...t, optional: true }),
  Record: (k: any, v: any) => ({ type: 'record' }),
};

const mockToolRegistry = {
  getEnabled: jest.fn().mockReturnValue([
    {
      name: 'my_tool',
      description: 'A test tool',
      handlerCode: 'async function execute(ctx) { return { message: "ok" }; }',
      parameters: [{ name: 'input', type: 'string', required: true }],
      authFields: [],
      confirm: false,
    },
  ]),
};

const mockCredentialService = {
  resolveCredentials: jest.fn().mockReturnValue({}),
};

const mockConfirmBridge = {
  requestConfirmation: jest.fn(),
};

describe('ToolAdapterService', () => {
  let service: ToolAdapterService;

  beforeEach(() => {
    service = new ToolAdapterService(
      mockToolRegistry as any,
      mockCredentialService as any,
      mockConfirmBridge as any,
    );
  });

  test('toolIds contains "tools"', () => {
    expect(service.toolIds).toEqual(['tools']);
  });

  test('getCatalog returns tool connector entry', () => {
    const catalog = service.getCatalog();
    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toEqual({ id: 'tools', label: 'Tool Connectors', group: '连接' });
  });

  test('createTools returns empty when no Type in context', async () => {
    const tools = await service.createTools({ userId: 'u1' });
    expect(tools).toEqual([]);
  });

  test('createTools builds tool_* prefixed tools from registry', async () => {
    const tools = await service.createTools({ userId: 'u1', piAi: { Type: mockType } });
    expect(tools.length).toBeGreaterThanOrEqual(1);
    expect(tools[0].name).toBe('tool_my_tool');
    expect(tools[0].description).toContain('A test tool');
    expect(typeof tools[0].execute).toBe('function');
  });

  // T-P-04（MC04）：确认请求带上当前用户与会话，confirmId 唯一
  test('confirm tool requests confirmation for the current user and session with a unique id', async () => {
    mockToolRegistry.getEnabled.mockReturnValueOnce([{
      name: 'confirm_tool', description: 'Needs confirm',
      handlerCode: 'async function execute(ctx) { return { message: "done " + ctx.params.input }; }',
      parameters: [{ name: 'input', type: 'string', required: true }],
      authFields: [], confirm: true,
    }]);
    mockConfirmBridge.requestConfirmation.mockResolvedValue({ input: 'edited' });
    const [tool] = await service.createTools({ userId: 'u1', sessionId: 's1', agentKey: 'main_s1', piAi: { Type: mockType } });
    const result = await tool.execute('id', { input: 'raw' });
    await tool.execute('id', { input: 'raw' });

    const [first, second] = mockConfirmBridge.requestConfirmation.mock.calls.map(c => c[0]);
    expect(first).toMatchObject({ toolName: 'confirm_tool', userId: 'u1', sessionId: 's1', args: { input: 'raw' } });
    expect(first.confirmId).toMatch(/^confirm_tool_\d+_[0-9a-f]{8}$/);
    expect(second.confirmId).not.toBe(first.confirmId);
    expect(result.content[0].text).toBe('done edited');
  });

  test('confirm timeout and cancel map to the existing user-facing messages', async () => {
    for (const [message, text] of [['confirm_timeout', '参数确认超时，操作已取消'], ['user_cancelled', '用户取消了此操作']]) {
      mockToolRegistry.getEnabled.mockReturnValueOnce([{
        name: 'confirm_tool', description: 'Needs confirm', handlerCode: 'async function execute() { return {}; }',
        parameters: [], authFields: [], confirm: true,
      }]);
      mockConfirmBridge.requestConfirmation.mockRejectedValueOnce(new Error(message));
      const [tool] = await service.createTools({ userId: 'u1', sessionId: 's1', agentKey: `k_${message}`, piAi: { Type: mockType } });
      const result = await tool.execute('id', {});
      expect(result.content[0].text).toBe(text);
    }
  });
});
