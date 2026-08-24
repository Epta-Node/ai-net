// src/hooks/useNetworkStats.ts
import { useEffect, useState, useCallback } from 'react';
import { getStats } from '../services/api';
import type { TimePoint } from '../types/api';

export interface NetworkStats {
  totalAgents: number;
  totalTasks: number;
  totalXLMTransacted: number;
  uptimePercent: number;
  tasksLast24h?: TimePoint[];
  xlmLast24h?: TimePoint[];
}

export const useNetworkStats = () => {
  const [data, setData] = useState<NetworkStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetch = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getStats();
      setData(res);
      setError(null);
    } catch (e) {
      setError(e as Error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch();
    const onFocus = () => fetch();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [fetch]);

  return { data, loading, error };
};
