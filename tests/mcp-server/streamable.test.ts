import express from 'express';
import { initStreamableServer } from '../../src/mcp-server/transport/streamable';
import { McpServerOptions } from '../../src/mcp-server/shared/types';
import { LarkAuthHandler } from '../../src/auth';

jest.mock('express', () => {
  const mockApp = {
    use: jest.fn(),
    post: jest.fn(),
    get: jest.fn(),
    delete: jest.fn(),
    listen: jest.fn().mockImplementation((port, host, callback) => {
      if (callback) callback();
      return { close: jest.fn() };
    }),
  };

  const mockExpressInstance = {
    json: jest.fn(),
  };

  const expressMock = jest.fn(() => mockApp);
  Object.assign(expressMock, {
    json: jest.fn(() => mockExpressInstance.json),
  });

  return expressMock;
});

jest.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    close: jest.fn(),
  })),
}));

jest.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
  StreamableHTTPServerTransport: jest.fn().mockImplementation((options) => ({
    options,
    sessionId: undefined,
    onclose: undefined,
    handleRequest: jest.fn().mockResolvedValue(undefined),
    close: jest.fn(),
  })),
}));

jest.mock('../../src/auth', () => ({
  LarkAuthHandler: jest.fn().mockImplementation(() => ({
    setupRoutes: jest.fn(),
  })),
}));

const createMockResponse = () => ({
  on: jest.fn(),
  writeHead: jest.fn().mockReturnThis(),
  end: jest.fn(),
  status: jest.fn().mockReturnThis(),
  json: jest.fn(),
});

const originalConsole = console;
const originalProcessExit = process.exit;

describe('initStreamableServer', () => {
  const mockApp = express();
  let postRouteHandler: any;
  let getRouteHandler: any;
  let deleteRouteHandler: any;
  let healthRouteHandler: any;

  beforeEach(() => {
    jest.clearAllMocks();

    console.log = jest.fn();
    console.error = jest.fn();
    process.exit = jest.fn() as any;

    (mockApp.post as jest.Mock).mockImplementation((path, handler) => {
      if (path === '/mcp') {
        postRouteHandler = handler;
      }
    });

    (mockApp.get as jest.Mock).mockImplementation((path, handler) => {
      if (path === '/mcp') {
        getRouteHandler = handler;
      } else if (path === '/health') {
        healthRouteHandler = handler;
      }
    });

    (mockApp.delete as jest.Mock).mockImplementation((path, handler) => {
      if (path === '/mcp') {
        deleteRouteHandler = handler;
      }
    });
  });

  afterEach(() => {
    console = originalConsole;
    process.exit = originalProcessExit;
  });

  it('初始化Express应用程序并设置正确的路由', () => {
    const options: McpServerOptions = { host: 'localhost', port: 3000 };

    initStreamableServer(jest.fn().mockReturnValue({}), options);

    expect(express).toHaveBeenCalled();
    expect(express.json).toHaveBeenCalled();
    expect(mockApp.use).toHaveBeenCalled();
    expect(mockApp.post).toHaveBeenCalledWith('/mcp', expect.any(Function));
    expect(mockApp.get).toHaveBeenCalledWith('/mcp', expect.any(Function));
    expect(mockApp.get).toHaveBeenCalledWith('/health', expect.any(Function));
    expect(mockApp.delete).toHaveBeenCalledWith('/mcp', expect.any(Function));
    expect(mockApp.listen).toHaveBeenCalledWith(options.port, options.host, expect.any(Function));
  });

  it('GET /health返回健康状态', async () => {
    const options: McpServerOptions = { host: 'localhost', port: 3000 };

    initStreamableServer(jest.fn().mockReturnValue({}), options);

    const mockRes = createMockResponse();
    await healthRouteHandler({}, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(200);
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'ok',
        service: 'lark-mcp-server',
      }),
    );
  });

  it('缺少host和port时抛出错误', () => {
    const invalidOptions: McpServerOptions = {};

    expect(() => {
      initStreamableServer(jest.fn(), invalidOptions);
    }).toThrow('[Lark MCP] Port and host are required');
  });

  it('新会话：从header解析凭证并合并，强制user_access_token', async () => {
    const options: McpServerOptions = { host: 'localhost', port: 3000 };
    const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
    const getMockServer = jest.fn().mockReturnValue({ connect: jest.fn().mockResolvedValue(undefined), close: jest.fn() });

    initStreamableServer(getMockServer, options);

    const mockReq = {
      headers: {
        'x-app-id': 'cli_xxx',
        'x-app-secret': 'secret',
        'x-user-access-token': 'u-xxx',
      },
      query: {},
      body: { jsonrpc: '2.0', method: 'initialize' },
    };
    const mockRes = createMockResponse();

    await postRouteHandler(mockReq, mockRes);

    expect(getMockServer).toHaveBeenCalledWith(
      {
        appId: 'cli_xxx',
        appSecret: 'secret',
        userAccessToken: 'u-xxx',
        tokenMode: 'user_access_token',
        host: 'localhost',
        port: 3000,
      },
      undefined,
    );

    const transportOptions = (StreamableHTTPServerTransport as jest.Mock).mock.calls[0][0];
    expect(transportOptions.sessionIdGenerator).toEqual(expect.any(Function));
    expect(transportOptions.onsessioninitialized).toEqual(expect.any(Function));
  });

  it('无header凭证时回退到启动凭证', async () => {
    const options: McpServerOptions = {
      appId: 'startup-app-id',
      appSecret: 'startup-app-secret',
      host: 'localhost',
      port: 3000,
    };
    const getMockServer = jest.fn().mockReturnValue({ connect: jest.fn().mockResolvedValue(undefined), close: jest.fn() });

    initStreamableServer(getMockServer, options);

    const mockReq = { headers: {}, query: {}, body: { jsonrpc: '2.0', method: 'initialize' } };
    const mockRes = createMockResponse();

    await postRouteHandler(mockReq, mockRes);

    expect(getMockServer).toHaveBeenCalledWith(
      {
        appId: 'startup-app-id',
        appSecret: 'startup-app-secret',
        host: 'localhost',
        port: 3000,
      },
      undefined,
    );
  });

  it('缺少凭证时返回401', async () => {
    const options: McpServerOptions = { host: 'localhost', port: 3000 };
    const getMockServer = jest.fn();

    initStreamableServer(getMockServer, options);

    const mockReq = { headers: {}, query: {}, body: { jsonrpc: '2.0', method: 'initialize' } };
    const mockRes = createMockResponse();

    await postRouteHandler(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(401);
    expect(getMockServer).not.toHaveBeenCalled();
  });

  it('appId不在白名单时返回401', async () => {
    const options: McpServerOptions = { host: 'localhost', port: 3000, allowAppIds: ['allowed-app'] };
    const getMockServer = jest.fn();

    initStreamableServer(getMockServer, options);

    const mockReq = {
      headers: { 'x-app-id': 'evil-app', 'x-app-secret': 'secret' },
      query: {},
      body: { jsonrpc: '2.0', method: 'initialize' },
    };
    const mockRes = createMockResponse();

    await postRouteHandler(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(401);
    expect(getMockServer).not.toHaveBeenCalled();
  });

  it('配置服务级token时，缺失token返回401', async () => {
    const options: McpServerOptions = {
      host: 'localhost',
      port: 3000,
      serverAccessTokens: ['secret-token'],
    };
    const getMockServer = jest.fn();

    initStreamableServer(getMockServer, options);

    const mockReq = {
      headers: { 'x-app-id': 'cli_xxx', 'x-app-secret': 'secret' },
      query: {},
      body: { jsonrpc: '2.0', method: 'initialize' },
    };
    const mockRes = createMockResponse();

    await postRouteHandler(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(401);
    expect(getMockServer).not.toHaveBeenCalled();
  });

  it('配置服务级token时，token不匹配返回401', async () => {
    const options: McpServerOptions = {
      host: 'localhost',
      port: 3000,
      serverAccessTokens: ['secret-token'],
    };
    const getMockServer = jest.fn();

    initStreamableServer(getMockServer, options);

    const mockReq = {
      headers: { 'x-app-id': 'cli_xxx', 'x-app-secret': 'secret', 'x-mcp-access-token': 'wrong' },
      query: {},
      body: { jsonrpc: '2.0', method: 'initialize' },
    };
    const mockRes = createMockResponse();

    await postRouteHandler(mockReq, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(401);
    expect(getMockServer).not.toHaveBeenCalled();
  });

  it('配置服务级token时，正确token放行', async () => {
    const options: McpServerOptions = {
      appId: 'startup-app-id',
      appSecret: 'startup-app-secret',
      host: 'localhost',
      port: 3000,
      serverAccessTokens: ['secret-token'],
    };
    const getMockServer = jest.fn().mockReturnValue({ connect: jest.fn().mockResolvedValue(undefined), close: jest.fn() });

    initStreamableServer(getMockServer, options);

    const mockReq = {
      headers: { 'x-mcp-access-token': 'secret-token' },
      query: {},
      body: { jsonrpc: '2.0', method: 'initialize' },
    };
    const mockRes = createMockResponse();

    await postRouteHandler(mockReq, mockRes);

    expect(getMockServer).toHaveBeenCalled();
  });

  it('从Authorization Bearer头回退解析user access token', async () => {
    const options: McpServerOptions = {
      appId: 'startup-app-id',
      appSecret: 'startup-app-secret',
      host: 'localhost',
      port: 3000,
    };
    const getMockServer = jest.fn().mockReturnValue({ connect: jest.fn().mockResolvedValue(undefined), close: jest.fn() });

    initStreamableServer(getMockServer, options);

    const mockReq = {
      headers: { authorization: 'Bearer test-bearer-token' },
      query: {},
      body: { jsonrpc: '2.0', method: 'initialize' },
    };
    const mockRes = createMockResponse();

    await postRouteHandler(mockReq, mockRes);

    expect(getMockServer).toHaveBeenCalledWith(
      expect.objectContaining({ userAccessToken: 'test-bearer-token', tokenMode: 'user_access_token' }),
      undefined,
    );
  });

  it('复用已有会话：命中mcp-session-id时不重建server', async () => {
    const options: McpServerOptions = {
      appId: 'startup-app-id',
      appSecret: 'startup-app-secret',
      host: 'localhost',
      port: 3000,
    };
    const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
    const getMockServer = jest.fn().mockReturnValue({ connect: jest.fn().mockResolvedValue(undefined), close: jest.fn() });

    initStreamableServer(getMockServer, options);

    const initReq = { headers: {}, query: {}, body: { jsonrpc: '2.0', method: 'initialize' } };
    await postRouteHandler(initReq, createMockResponse());

    // 模拟 transport 触发 onsessioninitialized
    const transport = (StreamableHTTPServerTransport as jest.Mock).mock.results[0].value;
    transport.options.onsessioninitialized('sid-1');

    const callReq = {
      headers: { 'mcp-session-id': 'sid-1' },
      body: { jsonrpc: '2.0', method: 'tools/call' },
    };
    await postRouteHandler(callReq, createMockResponse());

    expect(getMockServer).toHaveBeenCalledTimes(1);
    expect(transport.handleRequest).toHaveBeenCalledTimes(2);
  });

  it('DELETE命中会话时转发到transport', async () => {
    const options: McpServerOptions = {
      appId: 'startup-app-id',
      appSecret: 'startup-app-secret',
      host: 'localhost',
      port: 3000,
    };
    const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
    const getMockServer = jest.fn().mockReturnValue({ connect: jest.fn().mockResolvedValue(undefined), close: jest.fn() });

    initStreamableServer(getMockServer, options);

    const initReq = { headers: {}, query: {}, body: { jsonrpc: '2.0', method: 'initialize' } };
    await postRouteHandler(initReq, createMockResponse());

    const transport = (StreamableHTTPServerTransport as jest.Mock).mock.results[0].value;
    transport.options.onsessioninitialized('sid-1');

    await deleteRouteHandler({ headers: { 'mcp-session-id': 'sid-1' } }, createMockResponse());

    expect(transport.handleRequest).toHaveBeenCalledTimes(2);
  });

  it('DELETE未命中会话时返回404', async () => {
    const options: McpServerOptions = {
      appId: 'startup-app-id',
      appSecret: 'startup-app-secret',
      host: 'localhost',
      port: 3000,
    };
    initStreamableServer(jest.fn().mockReturnValue({}), options);

    const mockRes = createMockResponse();
    await deleteRouteHandler({ headers: { 'mcp-session-id': 'unknown' } }, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(404);
  });

  it('GET /mcp返回405方法不允许', async () => {
    const options: McpServerOptions = { host: 'localhost', port: 3000 };
    initStreamableServer(jest.fn().mockReturnValue({}), options);

    const mockRes = createMockResponse();
    await getRouteHandler({}, mockRes);

    expect(mockRes.writeHead).toHaveBeenCalledWith(405);
    expect(mockRes.end).toHaveBeenCalledWith(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed.' },
        id: null,
      }),
    );
  });

  it('启用OAuth时创建认证处理器', () => {
    const options: McpServerOptions = {
      appId: 'test-app-id',
      appSecret: 'test-app-secret',
      host: 'localhost',
      port: 3000,
      oauth: true,
    };

    initStreamableServer(jest.fn().mockReturnValue({}), options, { needAuthFlow: true });

    expect(LarkAuthHandler).toHaveBeenCalledWith(mockApp, options);
  });

  it('服务端代理模式（无oauth）时不创建认证处理器', () => {
    const options: McpServerOptions = { host: 'localhost', port: 3000 };

    initStreamableServer(jest.fn().mockReturnValue({}), options, { needAuthFlow: true });

    expect(LarkAuthHandler).not.toHaveBeenCalled();
  });

  it('服务器启动错误时记录日志并退出', () => {
    const options: McpServerOptions = { host: 'localhost', port: 3000 };

    (mockApp.listen as jest.Mock).mockImplementation((port, host, callback) => {
      if (callback) callback(new Error('Port already in use'));
      return { close: jest.fn() };
    });

    initStreamableServer(jest.fn().mockReturnValue({}), options);

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Server error'));
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});
