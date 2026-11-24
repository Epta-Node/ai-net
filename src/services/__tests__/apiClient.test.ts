// Issue #725: Unit tests for API client (timeout, abort, non-JSON, 4xx/5xx)

import { ApiClient, ApiClientError } from '../apiClient';

describe('ApiClient', () => {
  let client: ApiClient;

  beforeEach(() => {
    client = new ApiClient({ baseUrl: 'https://api.test.com', timeout: 1000 });
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('timeout handling', () => {
    it('should timeout after configured duration', async () => {
      (global.fetch as jest.Mock).mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 2000))
      );

      await expect(client.get('/test')).rejects.toThrow(ApiClientError);
      await expect(client.get('/test')).rejects.toMatchObject({
        code: 'TIMEOUT',
        retryable: true,
        status: 408,
      });
    });
  });

  describe('abort signal', () => {
    it('should respect abort signal', async () => {
      const controller = new AbortController();
      
      (global.fetch as jest.Mock).mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 1000))
      );

      setTimeout(() => controller.abort(), 100);

      await expect(client.get('/test', controller.signal)).rejects.toThrow(ApiClientError);
    });
  });

  describe('non-JSON response', () => {
    it('should handle text responses', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        text: jest.fn().mockResolvedValue('Plain text response'),
        headers: new Headers({ 'content-type': 'text/plain' }),
      });

      const result = await client.get('/test');
      expect(result).toBe('Plain text response');
    });

    it('should handle non-JSON error responses', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: false,
        status: 500,
        text: jest.fn().mockResolvedValue('Internal Server Error'),
        json: jest.fn().mockRejectedValue(new Error('Not JSON')),
        headers: new Headers({ 'content-type': 'text/html' }),
      });

      await expect(client.get('/test')).rejects.toMatchObject({
        message: 'Internal Server Error',
        status: 500,
        retryable: true,
      });
    });
  });

  describe('4xx errors', () => {
    it('should handle 400 Bad Request', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: false,
        status: 400,
        json: jest.fn().mockResolvedValue({
          message: 'Invalid request',
          code: 'BAD_REQUEST',
        }),
      });

      await expect(client.get('/test')).rejects.toMatchObject({
        message: 'Invalid request',
        status: 400,
        code: 'BAD_REQUEST',
        retryable: false,
      });
    });

    it('should handle 404 Not Found', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: false,
        status: 404,
        json: jest.fn().mockResolvedValue({
          message: 'Resource not found',
        }),
      });

      await expect(client.get('/test')).rejects.toMatchObject({
        status: 404,
        retryable: false,
      });
    });

    it('should mark 429 as retryable', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: false,
        status: 429,
        json: jest.fn().mockResolvedValue({
          message: 'Too many requests',
        }),
      });

      await expect(client.get('/test')).rejects.toMatchObject({
        status: 429,
        retryable: true,
      });
    });
  });

  describe('5xx errors', () => {
    it('should handle 500 Internal Server Error', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: false,
        status: 500,
        json: jest.fn().mockResolvedValue({
          message: 'Server error',
        }),
      });

      await expect(client.get('/test')).rejects.toMatchObject({
        status: 500,
        retryable: true,
      });
    });

    it('should handle 503 Service Unavailable', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: false,
        status: 503,
        json: jest.fn().mockResolvedValue({
          message: 'Service unavailable',
        }),
      });

      await expect(client.get('/test')).rejects.toMatchObject({
        status: 503,
        retryable: true,
      });
    });
  });

  describe('network errors', () => {
    it('should handle network failure', async () => {
      (global.fetch as jest.Mock).mockRejectedValue(new TypeError('Failed to fetch'));

      await expect(client.get('/test')).rejects.toMatchObject({
        message: 'Network error',
        code: 'NETWORK_ERROR',
        retryable: true,
      });
    });
  });

  describe('idempotency key', () => {
    it('should add idempotency key to POST when requested', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ success: true }),
      });

      await client.post('/test', { data: 'test' }, { idempotent: true });

      const fetchCall = (global.fetch as jest.Mock).mock.calls[0][1];
      expect(fetchCall.headers['Idempotency-Key']).toBeDefined();
    });
  });
});
