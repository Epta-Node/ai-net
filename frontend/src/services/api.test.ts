import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { apiClient, ApiError } from './api';
import * as RouteProgressContext from '../context/RouteProgressContext';

// Mock the progress context
vi.mock('../context/RouteProgressContext', () => ({
  progressStart: vi.fn(),
  progressDone: vi.fn(),
  progressError: vi.fn(),
}));

// Track window events
const windowEvents: Record<string, CustomEvent[]> = {};
const originalDispatchEvent = window.dispatchEvent;

describe('services/api', () => {
  beforeEach(() => {
    // Reset all mocks
    vi.clearAllMocks();

    // Clear event tracking
    Object.keys(windowEvents).forEach(key => delete windowEvents[key]);

    // Mock localStorage
    const localStorageMock = {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
    };
    Object.defineProperty(window, 'localStorage', {
      value: localStorageMock,
      writable: true,
    });

    // Track window events
    window.dispatchEvent = vi.fn((event: Event) => {
      if (event instanceof CustomEvent) {
        const eventType = event.type;
        if (!windowEvents[eventType]) {
          windowEvents[eventType] = [];
        }
        windowEvents[eventType].push(event);
      }
      return true;
    });
  });

  afterEach(() => {
    window.dispatchEvent = originalDispatchEvent;
    vi.clearAllMocks();
  });

  describe('ApiError', () => {
    it('creates an error with statusCode and path', () => {
      const error = new ApiError(404, 'Not found', '/api/test');

      expect(error.message).toBe('Not found');
      expect(error.statusCode).toBe(404);
      expect(error.path).toBe('/api/test');
      expect(error.name).toBe('ApiError');
    });
  });

  describe('apiClient.get', () => {
    it('fetches and returns JSON data on successful 200 response', async () => {
      const mockData = { id: 1, name: 'test' };
      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve(mockData),
        } as Response)
      );

      const result = await apiClient.get('/api/test');

      expect(result).toEqual(mockData);
      expect(RouteProgressContext.progressStart).toHaveBeenCalled();
      expect(RouteProgressContext.progressDone).toHaveBeenCalled();
    });

    it('handles 204 no-content response', async () => {
      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 204,
          headers: new Headers({ 'content-type': 'application/json' }),
        } as Response)
      );

      const result = await apiClient.get('/api/test');

      expect(result).toEqual({});
      expect(RouteProgressContext.progressDone).toHaveBeenCalled();
    });

    it('includes Authorization header when wallet_pubkey exists in localStorage', async () => {
      const mockPubKey = 'GBL3F46SKMWEPN4S5PQHCHFZ5NFPPF2YUFFJUJDT6PEJQJCIDQ3VLKJ';
      (window.localStorage.getItem as any).mockReturnValue(mockPubKey);

      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve({}),
        } as Response)
      );

      await apiClient.get('/api/test');

      const fetchCall = (global.fetch as any).mock.calls[0];
      const headers = fetchCall[1].headers;
      expect(headers['Authorization']).toBe(`Bearer ${mockPubKey}`);
    });

    it('falls back to walletAddress from localStorage if wallet_pubkey not found', async () => {
      const mockAddress = 'GABCDEF123';
      (window.localStorage.getItem as any).mockImplementation((key: string) => {
        if (key === 'wallet_pubkey') return null;
        if (key === 'walletAddress') return mockAddress;
        return null;
      });

      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve({}),
        } as Response)
      );

      await apiClient.get('/api/test');

      const fetchCall = (global.fetch as any).mock.calls[0];
      const headers = fetchCall[1].headers;
      expect(headers['Authorization']).toBe(`Bearer ${mockAddress}`);
    });

    it('omits Authorization header when neither wallet_pubkey nor walletAddress exists', async () => {
      (window.localStorage.getItem as any).mockReturnValue(null);

      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve({}),
        } as Response)
      );

      await apiClient.get('/api/test');

      const fetchCall = (global.fetch as any).mock.calls[0];
      const headers = fetchCall[1].headers;
      expect(headers['Authorization']).toBeUndefined();
    });
  });

  describe('apiClient.post', () => {
    it('posts JSON data and returns response', async () => {
      const requestBody = { name: 'test' };
      const responseData = { id: 1, ...requestBody };

      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve(responseData),
        } as Response)
      );

      const result = await apiClient.post('/api/test', requestBody);

      expect(result).toEqual(responseData);
      const fetchCall = (global.fetch as any).mock.calls[0];
      expect(fetchCall[1].method).toBe('POST');
      expect(fetchCall[1].body).toBe(JSON.stringify(requestBody));
    });

    it('posts without body when body is undefined', async () => {
      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve({}),
        } as Response)
      );

      await apiClient.post('/api/test');

      const fetchCall = (global.fetch as any).mock.calls[0];
      expect(fetchCall[1].body).toBeUndefined();
    });
  });

  describe('apiClient.delete', () => {
    it('sends DELETE request and returns response', async () => {
      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve({ success: true }),
        } as Response)
      );

      const result = await apiClient.delete('/api/test/1');

      expect(result).toEqual({ success: true });
      const fetchCall = (global.fetch as any).mock.calls[0];
      expect(fetchCall[1].method).toBe('DELETE');
    });
  });

  describe('error handling', () => {
    it('throws ApiError with structured message on 4xx response', async () => {
      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 404,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve({ message: 'Resource not found' }),
          text: () => Promise.resolve(''),
        } as Response)
      );

      await expect(apiClient.get('/api/missing')).rejects.toThrow(ApiError);
      const error = await apiClient.get('/api/missing').catch((e) => e);
      expect(error.statusCode).toBe(404);
      expect(error.path).toBe('/api/missing');
    });

    it('parses nested error structure { error: { message } }', async () => {
      const errorMessage = 'Validation failed';
      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 400,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve({ error: { message: errorMessage } }),
          text: () => Promise.resolve(''),
        } as Response)
      );

      try {
        await apiClient.get('/api/test');
      } catch (err: any) {
        expect(err.message).toBe(errorMessage);
      }
    });

    it('falls back to error.message on flat structure { message }', async () => {
      const errorMessage = 'Something went wrong';
      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 500,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve({ message: errorMessage }),
          text: () => Promise.resolve(''),
        } as Response)
      );

      try {
        await apiClient.get('/api/test');
      } catch (err: any) {
        expect(err.message).toBe(errorMessage);
      }
    });

    it('parses plain text error response when JSON fails', async () => {
      const errorText = 'Internal Server Error';
      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 500,
          headers: new Headers({ 'content-type': 'text/plain' }),
          json: () => Promise.reject(new Error('Not JSON')),
          text: () => Promise.resolve(errorText),
        } as Response)
      );

      try {
        await apiClient.get('/api/test');
      } catch (err: any) {
        expect(err.message).toContain(errorText);
      }
    });

    it('uses generic message when both JSON and text parsing fail', async () => {
      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 500,
          headers: new Headers({}),
          json: () => Promise.reject(new Error()),
          text: () => Promise.reject(new Error()),
        } as Response)
      );

      try {
        await apiClient.get('/api/test');
      } catch (err: any) {
        expect(err.message).toContain('HTTP error! status: 500');
      }
    });
  });

  describe('401 handling', () => {
    it('dispatches wallet_disconnected event on 401 response', async () => {
      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 401,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve({ message: 'Unauthorized' }),
          text: () => Promise.resolve(''),
        } as Response)
      );

      try {
        await apiClient.get('/api/protected');
      } catch (err) {
        // Expected to throw
      }

      expect(window.dispatchEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'wallet_disconnected'
        })
      );
    });

    it('shows warning toast on 401 response', async () => {
      const dispatchEventMock = vi.spyOn(window, 'dispatchEvent');

      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 401,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve({}),
          text: () => Promise.resolve(''),
        } as Response)
      );

      try {
        await apiClient.get('/api/test');
      } catch (err) {
        // Expected
      }

      const toastEvent = dispatchEventMock.mock.calls.find(
        call => call[0] instanceof CustomEvent && call[0].type === 'app-toast'
      );
      expect(toastEvent).toBeDefined();
    });
  });

  describe('503 retry with exponential backoff', () => {
    it('retries on 503 up to maxRetries', async () => {
      let attemptCount = 0;

      global.fetch = vi.fn(() => {
        attemptCount++;
        if (attemptCount < 3) {
          return Promise.resolve({
            ok: false,
            status: 503,
            headers: new Headers({ 'content-type': 'application/json' }),
            json: () => Promise.resolve({}),
            text: () => Promise.resolve(''),
          } as Response);
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve({ success: true }),
        } as Response);
      });

      vi.useFakeTimers();
      const promise = apiClient.get('/api/test');

      // Advance through all retries
      await vi.runAllTimersAsync();

      const result = await promise;
      expect(result).toEqual({ success: true });
      expect(attemptCount).toBe(3);
      vi.useRealTimers();
    });

    it('throws on 503 after maxRetries exhausted', async () => {
      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 503,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve({ message: 'Service unavailable' }),
          text: () => Promise.resolve(''),
        } as Response)
      );

      vi.useFakeTimers();
      const promise = apiClient.get('/api/test');
      await vi.runAllTimersAsync();

      try {
        await promise;
        throw new Error('Should have thrown');
      } catch (err: any) {
        expect(err).toBeInstanceOf(ApiError);
        expect(err.statusCode).toBe(503);
      }
      vi.useRealTimers();
    });

    it('uses exponential backoff: 1s, 2s, 4s for retries', async () => {
      const delays: number[] = [];
      let attemptCount = 0;

      global.fetch = vi.fn(() => {
        attemptCount++;
        if (attemptCount <= 3) {
          return Promise.resolve({
            ok: false,
            status: 503,
            headers: new Headers({ 'content-type': 'application/json' }),
            json: () => Promise.resolve({}),
            text: () => Promise.resolve(''),
          } as Response);
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve({ success: true }),
        } as Response);
      });

      const originalSetTimeout = global.setTimeout;
      global.setTimeout = vi.fn((callback, delay) => {
        delays.push(delay);
        return originalSetTimeout(callback, delay);
      });

      vi.useFakeTimers();
      const promise = apiClient.get('/api/test');
      await vi.runAllTimersAsync();
      await promise;

      expect(delays).toContain(1000); // First retry: 1s
      expect(delays).toContain(2000); // Second retry: 2s
      expect(delays).toContain(4000); // Third retry: 4s
      vi.useRealTimers();
    });
  });

  describe('route progress counter balance', () => {
    it('calls progressStart and progressDone on successful request', async () => {
      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve({ data: 'test' }),
        } as Response)
      );

      await apiClient.get('/api/test');

      expect(RouteProgressContext.progressStart).toHaveBeenCalledTimes(1);
      expect(RouteProgressContext.progressDone).toHaveBeenCalledTimes(1);
      expect(RouteProgressContext.progressError).not.toHaveBeenCalled();
    });

    it('balances progress counter on error response', async () => {
      global.fetch = vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 500,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve({ message: 'Error' }),
          text: () => Promise.resolve(''),
        } as Response)
      );

      try {
        await apiClient.get('/api/test');
      } catch (err) {
        // Expected
      }

      expect(RouteProgressContext.progressStart).toHaveBeenCalledTimes(1);
      expect(RouteProgressContext.progressError).toHaveBeenCalledTimes(1);
      // progressDone is called in the catch block to ensure balance
      expect(RouteProgressContext.progressDone).toHaveBeenCalled();
    });

    it('balances progress counter on network error', async () => {
      global.fetch = vi.fn(() => Promise.reject(new Error('Network error')));

      try {
        await apiClient.get('/api/test');
      } catch (err) {
        // Expected
      }

      expect(RouteProgressContext.progressStart).toHaveBeenCalledTimes(1);
      expect(RouteProgressContext.progressError).toHaveBeenCalledTimes(1);
      // progressDone is called in catch block
      expect(RouteProgressContext.progressDone).toHaveBeenCalled();
    });
  });
});
