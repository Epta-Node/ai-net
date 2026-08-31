import { useEffect, useMemo, useRef, useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { DAGPreview } from './DAGPreview';
import { useTaskSubmit } from '../../hooks/useTaskSubmit';
import { useToast } from '../../context/ToastContext';
import type { AgentPreference, TaskSubmitResponse } from '../../services/taskService';

// Only the label is translated: `value` is the wire format the API and the zod
// enum below rely on, so it stays in English regardless of the UI language.
const AGENT_PREFERENCE_VALUES = ['research', 'risk', 'coding', 'design', 'report'] as const;

/**
 * A factory because zod bakes the message strings in at schema construction
 * time, and `t` only exists inside the component.
 */
const makeTaskSchema = (t: TFunction) =>
  z.object({
    prompt: z
      .string()
      .trim()
      .min(1, t('validation.promptRequired'))
      .max(1000, t('validation.promptTooLong')),
    maxBudgetXLM: z.preprocess((value) => {
      if (typeof value === 'string') {
        return Number(value);
      }
      return value;
    }, z.number().min(0.1, t('validation.minBudget'))),
    agentPreferences: z.array(z.enum(AGENT_PREFERENCE_VALUES)).min(1, t('validation.agentRequired')),
  });

type TaskFormValues = z.infer<ReturnType<typeof makeTaskSchema>>;

export function TaskSubmissionForm() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [preview, setPreview] = useState<TaskSubmitResponse['dagPreview'] | null>(null);
  const { submitTask, status, error, data } = useTaskSubmit();
  const { showToast } = useToast();

  const agentPreferences = useMemo(
    () =>
      AGENT_PREFERENCE_VALUES.map((value) => ({
        value,
        label: t(`task.submit.pref.${value}`),
      })),
    [t],
  );

  const taskSchema = useMemo(() => makeTaskSchema(t), [t]);

  const {
    register,
    handleSubmit,
    control,
    trigger,
    formState: { errors, isSubmitting, isSubmitted },
  } = useForm<TaskFormValues>({
    resolver: zodResolver(taskSchema),
    defaultValues: {
      prompt: '',
      maxBudgetXLM: 0.1,
      agentPreferences: [],
    },
  });

  // Validation messages are copied into `errors` when validation runs, so an
  // error already on screen would keep the previous language. React Hook Form
  // re-reads `resolver` on every render, so re-validating here is enough.
  const language = i18n.language;
  const lastLanguage = useRef(language);
  useEffect(() => {
    if (lastLanguage.current === language) {
      return;
    }
    lastLanguage.current = language;
    if (isSubmitted) {
      void trigger();
    }
  }, [language, isSubmitted, trigger]);

  const onSubmit = async (values: TaskFormValues) => {
    try {
      const result = await submitTask(values);
      setPreview(result.dagPreview);

      window.setTimeout(() => {
        navigate(`/tasks/${result.taskId}`);
      }, 300);
    } catch (submitError) {
      const message =
        submitError instanceof Error ? submitError.message : t('task.submit.unableToSubmit');
      showToast(message, 'error');
    }
  };

  const previewData = preview ?? data?.dagPreview;
  const isLoading = status === 'loading' || isSubmitting;

  const budgetHelperText = useMemo(() => {
    if (errors.maxBudgetXLM) {
      return errors.maxBudgetXLM.message;
    }
    return t('task.submit.budgetHelper');
  }, [errors.maxBudgetXLM, t]);

  return (
    <main style={{ maxWidth: 900, margin: '0 auto', padding: '24px' }}>
      <h1>{t('task.submit.title')}</h1>

      <form onSubmit={handleSubmit(onSubmit)} noValidate id="task-form">
        <div style={{ marginBottom: 20 }}>
          <label htmlFor="prompt" style={{ display: 'block', marginBottom: 8, fontWeight: 600 }}>
            {t('task.submit.promptLabel')}
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
          <p id="prompt-error" style={{ color: 'var(--danger)', marginTop: 8 }}>
            {errors.prompt?.message}
          </p>
        </div>

        <div style={{ marginBottom: 20 }}>
          <label htmlFor="maxBudgetXLM" style={{ display: 'block', marginBottom: 8, fontWeight: 600 }}>
            {t('task.submit.budgetLabel')}
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
          <p id="budget-error" style={{ color: 'var(--danger)', marginTop: 8 }}>
            {budgetHelperText}
          </p>
        </div>

        <div style={{ marginBottom: 20 }}>
          <span id="agentPreferences-label" style={{ display: 'block', marginBottom: 8, fontWeight: 600 }}>
            {t('task.submit.preferencesLabel')}
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
          <p id="agentPreferences-error" style={{ color: 'var(--danger)', marginTop: 8 }}>
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
              background: 'var(--primary)',
              color: '#ffffff',
              cursor: isLoading ? 'not-allowed' : 'pointer',
            }}
          >
            {isLoading ? t('task.submit.submitting') : t('task.submit.submit')}
          </button>
          {status === 'success' && (
            <span style={{ color: 'var(--success)' }}>{t('task.submit.success')}</span>
          )}
        </div>
      </form>

      <section style={{ marginBottom: 24 }}>
        <h2>{t('task.submit.dagTitle')}</h2>
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
            background: 'var(--bg-secondary)',
            color: 'var(--danger)',
            border: '1px solid var(--danger)',
          }}
        >
          {error}
        </div>
      )}
    </main>
  );
}
