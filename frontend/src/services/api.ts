import { NetworkStats, TaskResponse, AgentRecord } from '../types/api';
import { progressStart, progressDone, progressError } from '../context/RouteProgressContext';

export class ApiError extends Error {
  statusCode: number;
  path: string;

  constructor(statusCode: number, message: string, path: string) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.path = path;
  }
}

const BASE_URL = import.meta.env.VITE_API_BASE_URL || '';

const notifyToast = (message: string, type: 'success' | 'error' | 'warning' | 'info' = 'info', duration?: number) => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('app-toast', { detail: { message, type, duration } }));
};

const getAuthHeader = (): Record<string, string> => {
  const pubKey = localStorage.getItem('wallet_pubkey') || localStorage.getItem('walletAddress');
  return pubKey ? { 'Authorization': `Bearer ${pubKey}` } : {};
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const baseDelay = 1000;
  const maxRetries = 3;
  let retryCount = 0;
  
  const fullUrl = `${BASE_URL}${path}`;

  progressStart();
  try {
  while (true) {
    let response: Response;
    try {
      const headers = {
        'Content-Type': 'application/json',
        ...getAuthHeader(),
        ...(init?.headers || {}),
      };
      
      response = await fetch(fullUrl, {
        ...init,
        headers,
      });
    } catch (err: unknown) {
      progressError();
      throw err;
    }

    if (response.status === 503 && retryCount < maxRetries) {
      const waitTime = baseDelay * Math.pow(2, retryCount);
      retryCount++;
      notifyToast('Service is temporarily unavailable. Retrying...', 'warning', 4000);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      continue;
    }

    if (response.status === 401) {
      notifyToast('Your wallet session expired. Please reconnect.', 'warning', 5000);
      window.dispatchEvent(new CustomEvent('wallet_disconnected'));
    }

    if (!response.ok) {
      let message = `HTTP error! status: ${response.status}`;
      try {
        const errorData = await response.json();
        message = errorData.error || errorData.message || message;
      } catch {
        try {
          const errorText = await response.text();
          message = errorText || message;
        } catch {}
      }
      progressError();
      throw new ApiError(response.status, message, path);
    }

    if (response.status === 204) {
      progressDone();
      return {} as T;
    }

    const contentType = response.headers?.get('content-type');
    const isJson = (contentType && contentType.includes('application/json')) || (typeof response.json === 'function' && typeof response.text !== 'function');

    progressDone();
    if (isJson && typeof response.json === 'function') {
      return response.json() as Promise<T>;
    }
    if (typeof response.text === 'function') {
      return response.text() as unknown as Promise<T>;
    }
    if (typeof response.json === 'function') {
      return response.json() as Promise<T>;
    }
    return {} as unknown as Promise<T>;
  }
  } catch (err) {
    // Ensure counter is balanced for any unexpected throw path
    progressDone();
    throw err;
  }
}

export const apiClient = {
  get: <T>(path: string, init?: Omit<RequestInit, 'method'>) =>
    request<T>(path, { ...init, method: 'GET' }),
    
  post: <T>(path: string, body?: unknown, init?: Omit<RequestInit, 'method' | 'body'>) =>
    request<T>(path, {
      ...init,
      method: 'POST',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
    
  delete: <T>(path: string, init?: Omit<RequestInit, 'method'>) =>
    request<T>(path, { ...init, method: 'DELETE' }),
};

export const getStats = async (): Promise<NetworkStats> => {
  return apiClient.get<NetworkStats>('/api/stats');
};

export const getRecentTasks = async (walletAddress: string): Promise<TaskResponse[]> => {
  return apiClient.get<TaskResponse[]>(`/api/wallets/${walletAddress}/tasks?limit=5`);
};

export const getAgents = async (): Promise<AgentRecord[]> => {
  return apiClient.get<AgentRecord[]>('/api/agents');
};

export const getAgentReputation = async (id: string): Promise<import('../types/agent').AgentReputation> => {
  return apiClient.get<import('../types/agent').AgentReputation>(`/api/agents/${id}/reputation`);
};
