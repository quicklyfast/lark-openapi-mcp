import { Request, Response } from 'express';
import { TokenMode } from '../../mcp-tool';
import { McpServerOptions, mcpServerOptionSchema } from '../shared';

/**
 * Credentials passed by the MCP client via HTTP headers.
 * Used in the server-side proxy mode to resolve credentials per session.
 */
export interface HeaderCredentials {
  appId?: string;
  appSecret?: string;
  userAccessToken?: string;
  domain?: string;
}

function headerValue(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function parseCredentialsFromRequest(req: Request): HeaderCredentials {
  return {
    appId: headerValue(req, 'x-app-id'),
    appSecret: headerValue(req, 'x-app-secret'),
    userAccessToken: headerValue(req, 'x-user-access-token'),
    domain: headerValue(req, 'x-domain'),
  };
}

export function parseBearerToken(req: Request): string | undefined {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return auth.slice('Bearer '.length);
  }
  return undefined;
}

/**
 * Merge header credentials into server options.
 * Header credentials take precedence over startup/query options.
 * When a user access token is provided via header, force user_access_token mode
 * so the SDK never falls back to a tenant access token.
 */
export function mergeHeaderCredentials(options: McpServerOptions, creds: HeaderCredentials): McpServerOptions {
  const hasUserToken = Boolean(creds.userAccessToken);
  return {
    ...options,
    appId: creds.appId || options.appId,
    appSecret: creds.appSecret || options.appSecret,
    domain: creds.domain || options.domain,
    userAccessToken: creds.userAccessToken || options.userAccessToken,
    tokenMode: hasUserToken ? TokenMode.USER_ACCESS_TOKEN : options.tokenMode,
  };
}

export enum JSONRPCErrorCodes {
  PARSE_ERROR = -32700,
  INVALID_REQUEST = -32600,
  METHOD_NOT_FOUND = -32601,
  INVALID_PARAMS = -32602,
  INTERNAL_ERROR = -32603,
}

export function parseMCPServerOptionsFromRequest(req: Request): {
  data: McpServerOptions;
  success: boolean;
  message?: string;
} {
  const result = mcpServerOptionSchema.safeParse(req.query || {});
  if (!result.success) {
    return { data: {}, success: false, message: result.error.message };
  }
  return { data: result.data as McpServerOptions, success: true };
}

export function sendJsonRpcError(
  res: Response,
  error: Error,
  httpCode = 500,
  code = JSONRPCErrorCodes.INTERNAL_ERROR,
  id: number | null = null,
) {
  console.error(error);
  if (!res.headersSent) {
    res.status(httpCode).json({ jsonrpc: '2.0', error: { code, message: error.message }, id });
  }
}

export function sendResponseError(res: Response, error: Error, httpCode = 500): void {
  console.error(error);
  if (!res.headersSent) {
    res.status(httpCode).send(error.message);
  }
}
