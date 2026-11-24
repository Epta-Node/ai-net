// src/hooks/useNetworkStats.ts
import { useEffect, useState, useCallback } from 'react';
import { getStats } from '../services/api';
import type { NetworkStats } from '../types/api';

export type { NetworkStats };

/** Same cadence as wallet balance polling, so new tasks show up within ~30s. */
export const NETWORK_STATS_REFRESH_MS = 30_000;

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
    const interval = setInterval(() => void fetch(), NETWORK_STATS_REFRESH_MS);
    return () => {
      window.removeEventListener('focus', onFocus);
      clearInterval(interval);
    };
  }, [fetch]);

  return { data, loading, error, retry: fetch };
};
