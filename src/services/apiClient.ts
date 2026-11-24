// Issue #725: Typed API client with unified error normalization

export class ApiClientError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string,
    public retryable: boolean,
    public originalError?: unknown
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

export interface ApiClientConfig {
  baseUrl: string;
  timeout?: number;
  headers?: Record<string, string>;
}

export class ApiClient {
  private baseUrl: string;
  private timeout: number;
  private defaultHeaders: Record<string, string>;

  constructor(config: ApiClientConfig) {
    this.baseUrl = config.baseUrl || import.meta.env.VITE_API_BASE_URL || '';
    this.timeout = config.timeout || 30000;
    this.defaultHeaders = config.headers || {};
  }

  /**
   * Inject authentication headers
   */
  private getHeaders(customHeaders?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.defaultHeaders,
    };

    // Inject auth token from localStorage/sessionStorage
    const authToken = localStorage.getItem('authToken');
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }

    // Add custom headers
    if (customHeaders) {
      Object.assign(headers, customHeaders);
    }

    return headers;
  }

  /**
   * Generate idempotency key for write operations
   */
  private generateIdempotencyKey(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(7)}`;
  }

  /**
   * Normalize HTTP errors into ApiClientError
   */
  private async handleResponse<T>(response: Response): Promise<T> {
    // Success responses
    if (response.ok) {
      const contentType = response.headers.get('content-type');
      
      if (contentType?.includes('application/json')) {
        return response.json();
      }
      
      return response.text() as any;
    }

    // Error responses
    let errorMessage = `HTTP ${response.status}`;
    let errorCode = `HTTP_${response.status}`;
    let retryable = false;

    try {
      const errorData = await response.json();
      errorMessage = errorData.message || errorMessage;
      errorCode = errorData.code || errorCode;
    } catch {
      // Non-JSON error response
      errorMessage = await response.text().catch(() => errorMessage);
    }

    // Determine if error is retryable
    if (response.status === 408 || response.status === 429 || response.status >= 500) {
      retryable = true;
    }

    throw new ApiClientError(errorMessage, response.status, errorCode, retryable);
  }

  /**
   * Make HTTP request with timeout and abort support
   */
  private async request<T>(
    method: string,
    endpoint: string,
    options: {
      body?: any;
      headers?: Record<string, string>;
      signal?: AbortSignal;
      idempotent?: boolean;
    } = {}
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const headers = this.getHeaders(options.headers);

    // Add idempotency key for POST/PUT/PATCH
    if (options.idempotent && ['POST', 'PUT', 'PATCH'].includes(method)) {
      headers['Idempotency-Key'] = this.generateIdempotencyKey();
    }

    // Create timeout controller
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), this.timeout);

    // Combine user signal with timeout signal
    const combinedSignal = options.signal
      ? this.combineSignals(options.signal, timeoutController.signal)
      : timeoutController.signal;

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: combinedSignal,
      });

      clearTimeout(timeoutId);
      return this.handleResponse<T>(response);
    } catch (error) {
      clearTimeout(timeoutId);

      // Handle abort/timeout
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new ApiClientError(
          'Request timeout',
          408,
          'TIMEOUT',
          true,
          error
        );
      }

      // Handle network errors
      if (error instanceof TypeError) {
        throw new ApiClientError(
          'Network error',
          0,
          'NETWORK_ERROR',
          true,
          error
        );
      }

      // Re-throw ApiClientError
      if (error instanceof ApiClientError) {
        throw error;
      }

      // Unknown error
      throw new ApiClientError(
        error instanceof Error ? error.message : 'Unknown error',
        0,
        'UNKNOWN_ERROR',
        false,
        error
      );
    }
  }

  /**
   * Combine multiple abort signals
   */
  private combineSignals(signal1: AbortSignal, signal2: AbortSignal): AbortSignal {
    const controller = new AbortController();

    signal1.addEventListener('abort', () => controller.abort());
    signal2.addEventListener('abort', () => controller.abort());

    return controller.signal;
  }

  /**
   * GET request
   */
  async get<T>(endpoint: string, signal?: AbortSignal): Promise<T> {
    return this.request<T>('GET', endpoint, { signal });
  }

  /**
   * POST request
   */
  async post<T>(
    endpoint: string,
    body?: any,
    options: { signal?: AbortSignal; idempotent?: boolean } = {}
  ): Promise<T> {
    return this.request<T>('POST', endpoint, { body, ...options });
  }

  /**
   * PUT request
   */
  async put<T>(
    endpoint: string,
    body?: any,
    options: { signal?: AbortSignal; idempotent?: boolean } = {}
  ): Promise<T> {
    return this.request<T>('PUT', endpoint, { body, ...options });
  }

  /**
   * DELETE request
   */
  async delete<T>(endpoint: string, signal?: AbortSignal): Promise<T> {
    return this.request<T>('DELETE', endpoint, { signal });
  }

  /**
   * PATCH request
   */
  async patch<T>(
    endpoint: string,
    body?: any,
    options: { signal?: AbortSignal; idempotent?: boolean } = {}
  ): Promise<T> {
    return this.request<T>('PATCH', endpoint, { body, ...options });
  }
}

// Singleton instance
export const apiClient = new ApiClient({
  baseUrl: import.meta.env.VITE_API_BASE_URL || '',
  timeout: 30000,
});
