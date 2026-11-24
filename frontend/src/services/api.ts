import {
  NetworkStats,
  AgentRecord,
  TaskCost,
  AgentWatchdogAlert,
  QuarantinedAgent,
} from '../types/api';
import { progressStart, progressDone, progressError } from '../context/RouteProgressContext';
import { readWalletSession } from './walletSession';
import { getTraceparent } from './tracing';

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

// Reads through the same session layer as WalletContext (#477), so a session
// restored on page load authenticates requests without a second storage key.
const getAuthHeader = (): Record<string, string> => {
  const pubKey = readWalletSession()?.publicKey;
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
      const headers = {
        'Content-Type': 'application/json',
        traceparent: getTraceparent(),
        ...getAuthHeader(),
        ...(init?.headers || {}),
      };
      const response = await fetch(fullUrl, { ...init, headers });

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
          message = errorData.error?.message || errorData.message || errorData.error || message;
        } catch {
          try {
            const errorText = await response.text();
            message = errorText || message;
          } catch {
            // Body already consumed or unreadable — keep the default message.
          }
        }
        throw new ApiError(response.status, message, path);
      }

      if (response.status === 204) {
        progressDone();
        return {} as T;
      }

      const contentType = response.headers?.get('content-type');
      const isJson = (contentType && contentType.includes('application/json')) || (typeof response.json === 'function' && typeof response.text !== 'function');

      if (isJson && typeof response.json === 'function') {
        const body = await response.json() as T;
        progressDone();
        return body;
      }
      if (typeof response.text === 'function') {
        const body = await response.text();
        progressDone();
        return body as T;
      }
      if (typeof response.json === 'function') {
        const body = await response.json() as T;
        progressDone();
        return body;
      }
      progressDone();
      return {} as T;
    }
  } catch (err) {
    // Every request settles the progress counter exactly once, including body errors.
    progressError();
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
  // The stats router is mounted at /api/stats and defines its own /stats route.
  return apiClient.get<NetworkStats>('/api/stats/stats');
};

/**
 * Token budget and LLM spend for one task (Issue #390).
 *
 * The backend scopes this to the calling wallet, so the session's public key is
 * attached via the shared auth header.
 */
export const getTaskCost = async (taskId: string): Promise<TaskCost> => {
  return apiClient.get<TaskCost>(`/api/tasks/${taskId}/cost`);
};

/** Recent watchdog alerts, newest first (Issue #379). */
export const getWatchdogAlerts = async (options: {
  limit?: number;
  unresolvedOnly?: boolean;
} = {}): Promise<AgentWatchdogAlert[]> => {
  const params = new URLSearchParams();
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  if (options.unresolvedOnly) params.set('unresolvedOnly', 'true');
  const query = params.toString();
  return apiClient.get<AgentWatchdogAlert[]>(
    `/api/agent-watchdog/alerts${query ? `?${query}` : ''}`,
  );
};

/** Agents currently inside their heartbeat grace period (Issue #379). */
export const getQuarantinedAgents = async (): Promise<QuarantinedAgent[]> => {
  return apiClient.get<QuarantinedAgent[]>('/api/agent-watchdog/quarantine');
};

export interface AgentPage {
  items: AgentRecord[];
  pagination: { limit: number; nextCursor: string | null; hasNextPage: boolean };
}

export const getAgentsPage = async (cursor?: string): Promise<AgentPage> => {
  const query = new URLSearchParams({ limit: '100' });
  if (cursor) query.set('cursor', cursor);
  const response = await apiClient.get<{ data: AgentPage }>(`/api/agents?${query}`);
  return response.data;
};

/** Bounded convenience read; use getAgentsPage to traverse the registry. */
export const getAgents = async (): Promise<AgentRecord[]> => {
  return (await getAgentsPage()).items;
};

/**
 * Fetch reputation data for a single agent by id (Issue #629).
 *
 * Returns dimensions scores plus a chronological score history so the
 * reputation hook and the AgentReputationTrend chart can render without
 * importing a non-existent symbol.
 */
export const getAgentReputation = async (agentId: string): Promise<import('../types/agent').AgentReputation> => {
  return apiClient.get<import('../types/agent').AgentReputation>(`/api/agents/${agentId}/reputation`);
};
