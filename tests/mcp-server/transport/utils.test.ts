import { Request, Response } from 'express';
import {
  JSONRPCErrorCodes,
  parseMCPServerOptionsFromRequest,
  parseCredentialsFromRequest,
  parseBearerToken,
  mergeHeaderCredentials,
  sendJsonRpcError,
  sendResponseError,
} from '../../../src/mcp-server/transport/utils';

// Mock console.error to avoid console output during tests
const mockConsoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

describe('mcp-server/transport/utils', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    mockConsoleError.mockRestore();
  });

  describe('parseMCPServerOptionsFromRequest', () => {
    it('should handle request with empty query', () => {
      const req = {
        query: {},
      } as any as Request;

      const result = parseMCPServerOptionsFromRequest(req);

      expect(result.success).toBe(true);
      expect(result.data).toEqual({});
      expect(result.message).toBeUndefined();
    });

    it('should handle request with undefined query', () => {
      const req = {} as any as Request;

      const result = parseMCPServerOptionsFromRequest(req);

      expect(result.success).toBe(true);
      expect(result.data).toEqual({});
      expect(result.message).toBeUndefined();
    });

    it('should return error for invalid schema', () => {
      const req = {
        query: {
          language: 'invalid-language', // 无效的语言值
        },
      } as any as Request;

      const result = parseMCPServerOptionsFromRequest(req);

      expect(result.success).toBe(false);
      expect(result.data).toEqual({});
      expect(result.message).toBeDefined();
      expect(result.message).toContain('Invalid enum value');
    });
  });

  describe('parseCredentialsFromRequest', () => {
    it('should parse credentials from headers', () => {
      const req = {
        headers: {
          'x-app-id': 'cli_xxx',
          'x-app-secret': 'secret',
          'x-user-access-token': 'u-xxx',
          'x-domain': 'https://open.larksuite.com',
        },
      } as any as Request;

      const result = parseCredentialsFromRequest(req);

      expect(result).toEqual({
        appId: 'cli_xxx',
        appSecret: 'secret',
        userAccessToken: 'u-xxx',
        domain: 'https://open.larksuite.com',
      });
    });

    it('should return empty object when no credential headers present', () => {
      const req = { headers: {} } as any as Request;

      const result = parseCredentialsFromRequest(req);

      expect(result).toEqual({
        appId: undefined,
        appSecret: undefined,
        userAccessToken: undefined,
        domain: undefined,
      });
    });
  });

  describe('parseBearerToken', () => {
    it('should extract token from Bearer authorization header', () => {
      const req = { headers: { authorization: 'Bearer abc123' } } as any as Request;

      expect(parseBearerToken(req)).toBe('abc123');
    });

    it('should return undefined for non-Bearer or missing authorization header', () => {
      expect(parseBearerToken({ headers: { authorization: 'Basic xyz' } } as any as Request)).toBeUndefined();
      expect(parseBearerToken({ headers: {} } as any as Request)).toBeUndefined();
    });
  });

  describe('mergeHeaderCredentials', () => {
    it('should let header credentials override options', () => {
      const options = {
        appId: 'startup-app-id',
        appSecret: 'startup-app-secret',
        host: 'localhost',
        port: 3000,
      } as any;

      const result = mergeHeaderCredentials(options, { appId: 'cli_xxx', appSecret: 'secret' });

      expect(result.appId).toBe('cli_xxx');
      expect(result.appSecret).toBe('secret');
      expect(result.host).toBe('localhost');
    });

    it('should force user_access_token mode when a user token is provided', () => {
      const options = { appId: 'cli_xxx', appSecret: 'secret', tokenMode: 'auto' } as any;

      const result = mergeHeaderCredentials(options, { userAccessToken: 'u-xxx' });

      expect(result.tokenMode).toBe('user_access_token');
      expect(result.userAccessToken).toBe('u-xxx');
    });

    it('should keep original tokenMode when no user token is provided', () => {
      const options = { appId: 'cli_xxx', appSecret: 'secret', tokenMode: 'auto' } as any;

      const result = mergeHeaderCredentials(options, {});

      expect(result.tokenMode).toBe('auto');
    });
  });

  describe('sendJsonRpcError', () => {
    let mockRes: Partial<Response>;

    beforeEach(() => {
      mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
        headersSent: false,
      } as any;
    });

    it('should send JSON RPC error with default parameters', () => {
      const error = new Error('Test error');

      sendJsonRpcError(mockRes as Response, error);

      expect(mockConsoleError).toHaveBeenCalledWith(error);
      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockRes.json).toHaveBeenCalledWith({
        jsonrpc: '2.0',
        error: {
          code: JSONRPCErrorCodes.INTERNAL_ERROR,
          message: 'Test error',
        },
        id: null,
      });
    });

    it('should send JSON RPC error with custom parameters', () => {
      const error = new Error('Custom error');
      const httpCode = 400;
      const code = JSONRPCErrorCodes.INVALID_REQUEST;
      const id = 123;

      sendJsonRpcError(mockRes as Response, error, httpCode, code, id);

      expect(mockConsoleError).toHaveBeenCalledWith(error);
      expect(mockRes.status).toHaveBeenCalledWith(httpCode);
      expect(mockRes.json).toHaveBeenCalledWith({
        jsonrpc: '2.0',
        error: {
          code,
          message: 'Custom error',
        },
        id,
      });
    });

    it('should not send response if headers already sent', () => {
      const error = new Error('Test error');
      mockRes.headersSent = true;

      sendJsonRpcError(mockRes as Response, error);

      expect(mockConsoleError).toHaveBeenCalledWith(error);
      expect(mockRes.status).not.toHaveBeenCalled();
      expect(mockRes.json).not.toHaveBeenCalled();
    });
  });

  describe('sendResponseError', () => {
    let mockRes: Partial<Response>;

    beforeEach(() => {
      mockRes = {
        status: jest.fn().mockReturnThis(),
        send: jest.fn().mockReturnThis(),
        headersSent: false,
      } as any;
    });

    it('should send response error', () => {
      const error = new Error('Response error');

      sendResponseError(mockRes as Response, error);

      expect(mockConsoleError).toHaveBeenCalledWith(error);
      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockRes.send).toHaveBeenCalledWith('Response error');
    });
  });
});
