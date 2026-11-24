import { useState, useEffect } from 'react';
import { getAgentReputation } from '../services/api';
import type { AgentReputation } from '../types/agent';

export function useAgentReputation(agentId: string) {
  const [data, setData] = useState<AgentReputation | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!agentId) return;

    let mounted = true;
    const fetchReputation = async () => {
      setLoading(true);
      setError(null);
      try {
        const result = await getAgentReputation(agentId);
        if (mounted) {
          setData(result);
        }
      } catch (err) {
        if (mounted) {
          setError(err instanceof Error ? err.message : 'Failed to fetch reputation data');
        }
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    };

    fetchReputation();

    return () => {
      mounted = false;
    };
  }, [agentId]);

  return { data, loading, error };
}
