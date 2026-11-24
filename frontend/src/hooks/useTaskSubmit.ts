import { useCallback, useState } from 'react';
import { createTask, TaskSubmissionPayload, TaskSubmitResponse } from '../services/taskService';
import { notifyTaskStarted } from './useWalletBalance';

export type TaskSubmitStatus = 'idle' | 'loading' | 'success' | 'error';

export function useTaskSubmit() {
  const [status, setStatus] = useState<TaskSubmitStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<TaskSubmitResponse | null>(null);

  const submitTask = useCallback(async (payload: TaskSubmissionPayload) => {
    setStatus('loading');
    setError(null);
    setData(null);

    try {
      const response = await createTask(payload);
      notifyTaskStarted();
      setData(response);
      setStatus('success');
      return response;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Network error';
      setError(message);
      setData(null);
      setStatus('error');
      throw err;
    }
  }, []);

  return {
    submitTask,
    status,
    error,
    data,
  };
}
