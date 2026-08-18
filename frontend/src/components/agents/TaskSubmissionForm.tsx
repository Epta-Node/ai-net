import { useMemo, useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useNavigate } from 'react-router-dom';
import { DAGPreview } from './DAGPreview';
import { useTaskSubmit } from '../../hooks/useTaskSubmit';
import { useToast } from '../../hooks/useToast';
import { useToast } from '../../context/ToastContext';
import type { AgentPreference, TaskSubmitResponse } from '../../services/taskService';

const agentPreferences = [
  { label: 'Research Agent', value: 'research' as const },
  { label: 'Risk Agent', value: 'risk' as const },
  { label: 'Coding Agent', value: 'coding' as const },
  { label: 'Design Agent', value: 'design' as const },
  { label: 'Report Agent', value: 'report' as const },
];

const taskSchema = z.object({
  prompt: z.string().trim().min(1, 'Prompt is required').max(1000, 'Prompt must be 1000 characters or less'),
  maxBudgetXLM: z
    .preprocess((value) => {
      if (typeof value === 'string') {
        return Number(value);
      }
      return value;
    }, z.number().min(0.1, 'Minimum budget is 0.1 XLM')),
  agentPreferences: z
    .array(z.enum(['research', 'risk', 'coding', 'design', 'report']))
    .min(1, 'Choose at least one agent'),
});

type TaskFormValues = z.infer<typeof taskSchema>;

export function TaskSubmissionForm() {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [preview, setPreview] = useState<TaskSubmitResponse['dagPreview'] | null>(null);
  const { submitTask, status, data } = useTaskSubmit();
  const [preview, setPreview] = useState<TaskSubmitResponse['dagPreview'] | null>(null);
  const { submitTask, status, error, data } = useTaskSubmit();
  const { showToast } = useToast();

  const {
    register,
    handleSubmit,
    control,
    formState: { errors, isSubmitting },
  } = useForm<TaskFormValues>({
    resolver: zodResolver(taskSchema),
    defaultValues: {
      prompt: '',
      maxBudgetXLM: 0.1,
      agentPreferences: [],
    },
  });

  const onSubmit = async (values: TaskFormValues) => {
    try {
      const result = await submitTask(values);
      setPreview(result.dagPreview);

      window.setTimeout(() => {
        navigate(`/tasks/${result.taskId}`);
      }, 300);
    } catch (submitError) {
      const message = submitError instanceof Error ? submitError.message : 'Unable to submit task';
      showToast(message, 'error');
    }
  };

  const previewData = preview ?? data?.dagPreview;
  const isLoading = status === 'loading' || isSubmitting;

  const budgetHelperText = useMemo(() => {
    if (errors.maxBudgetXLM) {
      return errors.maxBudgetXLM.message;
    }
    return 'Budget must be at least 0.1 XLM.';
  }, [errors.maxBudgetXLM]);

  return (
    <main style={{ maxWidth: 900, margin: '0 auto', padding: '24px' }}>
      <h1>Submit a New Task</h1>

      <form onSubmit={handleSubmit(onSubmit)} noValidate id="task-form">
        <div style={{ marginBottom: 20 }}>
          <label htmlFor="prompt" style={{ display: 'block', marginBottom: 8, fontWeight: 600 }}>
            Task prompt
          </label>
          <textarea
            id="prompt"
            {...register('prompt')}
            rows={6}
            maxLength={1000}
            style={{ width: '100%', padding: 12, borderRadius: 10, border: '1px solid var(--border-color)' }}
            aria-invalid={Boolean(errors.prompt)}
            aria-describedby="prompt-error"
          />
          <p id="prompt-error" style={{ color: '#b91c1c', marginTop: 8 }}>
            {errors.prompt?.message}
          </p>
        </div>

        <div style={{ marginBottom: 20 }}>
          <label htmlFor="maxBudgetXLM" style={{ display: 'block', marginBottom: 8, fontWeight: 600 }}>
            Maximum budget (XLM)
          </label>
          <input
            id="maxBudgetXLM"
            type="number"
            step="0.1"
            min="0.1"
            {...register('maxBudgetXLM', { valueAsNumber: true })}
            style={{ width: 180, padding: 12, borderRadius: 10, border: '1px solid var(--border-color)' }}
            aria-invalid={Boolean(errors.maxBudgetXLM)}
            aria-describedby="budget-error"
          />
          <p id="budget-error" style={{ color: '#b91c1c', marginTop: 8 }}>
            {budgetHelperText}
          </p>
        </div>

        <div style={{ marginBottom: 20 }}>
          <span id="agentPreferences-label" style={{ display: 'block', marginBottom: 8, fontWeight: 600 }}>
            Agent preferences
          </span>
          <Controller
            control={control}
            name="agentPreferences"
            render={({ field }) => (
              <div
                role="group"
                aria-labelledby="agentPreferences-label"
                aria-describedby="agentPreferences-error"
                aria-invalid={Boolean(errors.agentPreferences)}
                style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}
              >
                {agentPreferences.map((option) => (
                  <label
                    key={option.value}
                    htmlFor={`pref-${option.value}`}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: 12,
                      borderRadius: 10,
                      border: '1px solid var(--border-color)',
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      id={`pref-${option.value}`}
                      type="checkbox"
                      value={option.value}
                      checked={field.value.includes(option.value)}
                      onChange={(event) => {
                        const current = field.value;
                        const next = event.target.checked
                          ? [...current, option.value]
                          : current.filter((value: AgentPreference) => value !== option.value);
                        field.onChange(next);
                      }}
                      onBlur={field.onBlur}
                      name={field.name}
                    />
                    {option.label}
                  </label>
                ))}
              </div>
            )}
          />
          <p id="agentPreferences-error" style={{ color: '#b91c1c', marginTop: 8 }}>
            {errors.agentPreferences?.message}
          </p>
        </div>

        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 32 }}>
          <button
            type="submit"
            id="btn-submit-task"
            disabled={isLoading}
            style={{
              padding: '12px 20px',
              borderRadius: 10,
              border: 'none',
              background: '#2563eb',
              color: '#ffffff',
              cursor: isLoading ? 'not-allowed' : 'pointer',
            }}
          >
            {isLoading ? 'Submitting...' : 'Submit task'}
          </button>
          {status === 'success' && (
            <span style={{ color: '#16a34a' }}>Task submitted successfully. Redirecting...</span>
          )}
        </div>
      </form>

      <section style={{ marginBottom: 24 }}>
        <h2>Execution DAG preview</h2>
        {isLoading && (
          <div aria-busy="true" style={{ padding: 24, background: 'var(--bg-secondary)', borderRadius: 12 }}>
            <div style={{ height: 18, width: '45%', background: 'var(--bg-surface-alt)', borderRadius: 8, marginBottom: 12 }} />
            <div style={{ height: 18, width: '70%', background: 'var(--bg-surface-alt)', borderRadius: 8, marginBottom: 12 }} />
            <div style={{ height: 18, width: '55%', background: 'var(--bg-surface-alt)', borderRadius: 8 }} />
          </div>
        )}
        {!isLoading && <DAGPreview dagPreview={previewData ?? undefined} />}
      </section>

      {error && (
        <div
          role="status"
          style={{
            marginTop: 24,
            padding: 16,
            borderRadius: 12,
            background: '#f8d7da',
            color: '#842029',
          }}
        >
          {error}
        </div>
      )}
    </main>
  );
}
