import express, { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InitTransportServerFunction } from '../shared';
import {
  parseMCPServerOptionsFromRequest,
  parseCredentialsFromRequest,
  parseBearerToken,
  parseServerAccessToken,
  mergeHeaderCredentials,
  sendJsonRpcError,
} from './utils';
import { LarkAuthHandler } from '../../auth';
import { logger } from '../../utils/logger';
import { currentVersion } from '../../utils/version';

interface StreamableSession {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  lastActivity: number;
}

// Sessions are kept in-memory keyed by the MCP session id. A session is created on the
// first `initialize` request and reused for every subsequent request, so the Lark Client
// and its tools are built exactly once per client connection.
const SESSION_TTL_MS = 30 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

export const initStreamableServer: InitTransportServerFunction = (
  getNewServer,
  options,
  { needAuthFlow } = { needAuthFlow: false },
) => {
  const { userAccessToken, oauth, port, host } = options;

  if (!port || !host) {
    throw new Error('[Lark MCP] Port and host are required');
  }

  const app = express();
  app.use(express.json());

  const sessions = new Map<string, StreamableSession>();

  let authHandler: LarkAuthHandler | undefined;

  // The local OAuth handler is only needed when the single-tenant OAuth login flow is
  // enabled. In the server-side proxy mode, credentials are provided per request via
  // headers and no local auth handler (which requires startup appId/appSecret) is used.
  if (!userAccessToken && needAuthFlow && oauth) {
    authHandler = new LarkAuthHandler(app, options);
    authHandler.setupRoutes();
  }

  const allowAppIds = options.allowAppIds || [];
  const serverAccessTokens = options.serverAccessTokens || [];

  const sendUnauthorized = (res: Response, message: string) => {
    res.status(401).json({ jsonrpc: '2.0', error: { code: -32000, message }, id: null });
  };

  // Guard the proxy service itself. When serverAccessTokens is configured, requests must
  // carry one of the tokens in the X-Mcp-Access-Token header; otherwise reject with 401.
  const requireServerAccessToken = (req: Request, res: Response): boolean => {
    if (!serverAccessTokens.length) {
      return true;
    }
    const token = parseServerAccessToken(req);
    if (token && serverAccessTokens.includes(token)) {
      return true;
    }
    logger.warn(`[StreamableServerTransport] Rejected request with invalid/missing MCP access token`);
    sendUnauthorized(res, 'Invalid or missing MCP access token');
    return false;
  };

  app.post('/mcp', async (req: Request, res: Response) => {
    try {
      if (!requireServerAccessToken(req, res)) {
        return;
      }

      const sessionId = req.headers['mcp-session-id'];

      // Reuse an existing session
      if (typeof sessionId === 'string' && sessions.has(sessionId)) {
        const session = sessions.get(sessionId)!;
        session.lastActivity = Date.now();
        await session.transport.handleRequest(req, res, req.body);
        return;
      }

      // New session: resolve credentials from headers (server-side proxy mode).
      // Fall back to startup credentials for backward compatibility (single-tenant).
      const creds = parseCredentialsFromRequest(req);
      if (!creds.userAccessToken) {
        creds.userAccessToken = parseBearerToken(req);
      }

      if (allowAppIds.length && creds.appId && !allowAppIds.includes(creds.appId)) {
        logger.warn(`[StreamableServerTransport] Rejected appId not in allowlist: ${creds.appId}`);
        sendUnauthorized(res, 'App ID is not allowed');
        return;
      }

      const data = parseMCPServerOptionsFromRequest(req).data;
      const merged = mergeHeaderCredentials({ ...options, ...data }, creds);

      if (!merged.appId || !merged.appSecret) {
        sendUnauthorized(res, 'Missing X-App-Id / X-App-Secret headers');
        return;
      }

      const server = getNewServer(merged, authHandler);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          sessions.set(sid, { server, transport, lastActivity: Date.now() });
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) {
          sessions.delete(sid);
        }
        server.close().catch((error) => logger.error(`[StreamableServerTransport] Error closing server: ${error}`));
      };

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      sendJsonRpcError(res, error as Error);
    }
  });

  app.delete('/mcp', async (req: Request, res: Response) => {
    try {
      if (!requireServerAccessToken(req, res)) {
        return;
      }

      const sessionId = req.headers['mcp-session-id'];
      if (typeof sessionId === 'string' && sessions.has(sessionId)) {
        await sessions.get(sessionId)!.transport.handleRequest(req, res);
        return;
      }
      res
        .status(404)
        .json({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null });
    } catch (error) {
      sendJsonRpcError(res, error as Error);
    }
  });

  const handleMethodNotAllowed = async (_req: Request, res: Response) => {
    res
      .writeHead(405)
      .end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }));
  };

  app.get('/mcp', async (req: Request, res: Response) => {
    try {
      await handleMethodNotAllowed(req, res);
    } catch (error) {
      sendJsonRpcError(res, error as Error);
    }
  });

  // Health check endpoint for orchestrators / load balancers. No service-level auth.
  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({
      status: 'ok',
      service: 'lark-mcp-server',
      version: currentVersion,
      uptime: Math.round(process.uptime()),
    });
  });

  // Reclaim idle sessions to avoid leaking Lark clients and MCP servers.
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const session of sessions.values()) {
      if (now - session.lastActivity > SESSION_TTL_MS) {
        void session.transport.close().catch(() => {});
      }
    }
  }, CLEANUP_INTERVAL_MS);
  cleanup.unref();

  app.listen(port, host, (error) => {
    if (error) {
      logger.error(`[StreamableServerTransport] Server error: ${error}`);
      process.exit(1);
    }
    console.log(`📡 Streamable endpoint: http://${host}:${port}/mcp`);
    logger.info(`[StreamableServerTransport] Streamable endpoint: http://${host}:${port}/mcp`);
  });
};
