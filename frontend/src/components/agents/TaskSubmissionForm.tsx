import { useEffect, useMemo, useRef, useState } from 'react';
import { useForm, Controller, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertCircle } from 'lucide-react';
import type { TFunction } from 'i18next';
import { DAGPreview } from './DAGPreview';
import { useTaskSubmit } from '../../hooks/useTaskSubmit';
import { useToast } from '../../context/ToastContext';
import { useTaskDraft } from '../../hooks/useTaskDraft';
import { buildLiveDag } from '../../utils/buildLiveDag';
import { WizardProgress } from '../wallet/WizardProgress';
import { WizardStep } from '../wallet/WizardStep';
import styles from './TaskWizard.module.css';
import type { AgentPreference } from '../../services/taskService';

// Only the label is translated: `value` is the wire format the API and the zod
// enum below rely on, so it stays in English regardless of the UI language.
const AGENT_PREFERENCE_VALUES = ['research', 'risk', 'coding', 'design', 'report'] as const;

const TOTAL_STEPS = 4;

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
      if (value === '' || value === undefined || value === null || (typeof value === 'number' && isNaN(value))) {
        return 0.1;
      }
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
  const { showToast } = useToast();
  const { load, save, clear } = useTaskDraft();
  const { submitTask, status, error } = useTaskSubmit();
  const pendingNav = useRef<number | null>(null);

  const initialDraft = useMemo(() => load(), [load]);
  const [currentStep, setCurrentStep] = useState<number>(initialDraft?.currentStep ?? 1);

  const agentPreferences = useMemo(
    () =>
      AGENT_PREFERENCE_VALUES.map((value) => ({
        value,
        label: t(`task.submit.pref.${value}`),
      })),
    [t],
  );

  const labelOf = useMemo(
    () => (preference: AgentPreference) => t(`task.submit.pref.${preference}`),
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
    mode: 'onChange',
    resolver: zodResolver(taskSchema),
    defaultValues: {
      prompt: initialDraft?.prompt ?? '',
      maxBudgetXLM: initialDraft?.maxBudgetXLM ?? 0.1,
      agentPreferences: initialDraft?.agentPreferences ?? [],
    },
  });

  const watchedValues = useWatch({ control });

  // ── Draft persistence ────────────────────────────────────────────────────────
  // Persist the in-progress form + current step on every change so navigating
  // away (route change, back button, tab close) and returning restores the
  // user's place. Cleared on a successful submit (see onSubmit).
  useEffect(() => {
    save({
      prompt: watchedValues.prompt ?? '',
      maxBudgetXLM:
        typeof watchedValues.maxBudgetXLM === 'number' && Number.isFinite(watchedValues.maxBudgetXLM)
          ? watchedValues.maxBudgetXLM
          : 0.1,
      agentPreferences: (watchedValues.agentPreferences ?? []) as AgentPreference[],
      currentStep,
    });
  }, [watchedValues, currentStep, save]);

  // ── i18n re-validation ───────────────────────────────────────────────────────
  // Validation messages are copied into `errors` when validation runs, so an
  // error already on screen would keep the previous language. React Hook Form
  // re-reads `resolver` on every render, so re-validating here is enough.
  const language = i18n.language;
  const lastLanguage = useRef(language);
  useEffect(() => {
    if (lastLanguage.current === language) return;
    lastLanguage.current = language;
    if (isSubmitted) void trigger();
  }, [language, isSubmitted, trigger]);

  useEffect(() => {
    return () => {
      if (pendingNav.current) window.clearTimeout(pendingNav.current);
    };
  }, []);

  // ── Live DAG preview ────────────────────────────────────────────────────────
  // Re-computed whenever the chosen agents change so the review step reflects
  // selections in real time (issue #376 acceptance criterion).
  const selectedPreferences = useWatch({ control, name: 'agentPreferences' }) as AgentPreference[];
  const liveDag = useMemo(
    () => buildLiveDag(selectedPreferences ?? [], labelOf),
    [selectedPreferences, labelOf],
  );

  const validateCurrentStep = async (): Promise<boolean> => {
    let valid = false;
    switch (currentStep) {
      case 1:
        valid = await trigger('prompt');
        break;
      case 2:
        valid = await trigger('agentPreferences');
        break;
      case 3:
        valid = await trigger('maxBudgetXLM');
        break;
      default:
        valid = true;
        break;
    }
    return valid;
  };

  const goNext = async () => {
    // Step-skipping prevention: advancement is gated on the current step's
    // validation passing. There is no other forward navigation path.
    const valid = await validateCurrentStep();
    if (valid) {
      setCurrentStep((step) => Math.min(step + 1, TOTAL_STEPS));
    }
  };

  const goBack = () => {
    setCurrentStep((step) => Math.max(step - 1, 1));
  };

  const onSubmit = async (values: TaskFormValues) => {
    try {
      const result = await submitTask(values);
      clear();

      const timer = window.setTimeout(() => {
        navigate(`/tasks/${result.taskId}`);
      }, 300);
      pendingNav.current = timer;

      showToast(t('task.submit.success'), 'success', {
        duration: 6000,
        action: {
          label: t('common.undo') || 'Undo',
          onClick: () => {
            if (pendingNav.current) {
              window.clearTimeout(pendingNav.current);
              pendingNav.current = null;
            }
            showToast('Task creation undone', 'info', 3000);
          },
        },
      });
    } catch (submitError) {
      const message =
        submitError instanceof Error ? submitError.message : t('task.submit.unableToSubmit');
      const isNetworkError =
        message.toLowerCase().includes('network') || message.toLowerCase().includes('fetch');
      showToast(message, 'error', {
        duration: isNetworkError ? 8000 : 6000,
        ...(isNetworkError
          ? {
              action: {
                label: t('common.retry') || 'Retry',
                onClick: () => {
                  void handleSubmit(onSubmit)();
                },
              },
            }
          : {}),
      });
    }
  };

  const isLoading = status === 'loading' || isSubmitting;

  const budgetHelperText = useMemo(() => {
    if (errors.maxBudgetXLM) {
      return errors.maxBudgetXLM.message;
    }
    return t('task.submit.budgetHelper');
  }, [errors.maxBudgetXLM, t]);

  const stepTitles = useMemo(
    () => ({
      goal: t('task.wizard.step.goal'),
      agents: t('task.wizard.step.agents'),
      review: t('task.wizard.step.review'),
      submit: t('task.wizard.step.submit'),
    }),
    [t],
  );

  const renderAgentSelectors = (field: {
    value: AgentPreference[];
    onChange: (next: AgentPreference[]) => void;
    onBlur: () => void;
    name: string;
  }) => (
    <div
      role="group"
      aria-labelledby="agentPreferences-label"
      aria-describedby="agentPreferences-error"
      aria-invalid={Boolean(errors.agentPreferences)}
      className={styles.agentGrid}
    >
      {agentPreferences.map((option) => (
        <label
          key={option.value}
          htmlFor={`pref-${option.value}`}
          className={styles.agentOption}
        >
          <input
            id={`pref-${option.value}`}
            type="checkbox"
            value={option.value}
            checked={field.value.includes(option.value as AgentPreference)}
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
  );

  return (
    <main className={styles.wizardWrapper}>
      <h1 className={styles.title}>{t('task.submit.title')}</h1>

      <div className={styles.progressHeader}>
        <WizardProgress currentStep={currentStep} totalSteps={TOTAL_STEPS} />
      </div>

      <WizardStep isActive={currentStep === 1}>
        <h2 className={styles.stepTitle}>{stepTitles.goal}</h2>
        <div className={styles.field}>
          <label htmlFor="prompt" className={styles.label}>
            {t('task.submit.promptLabel')}
          </label>
          <textarea
            id="prompt"
            {...register('prompt')}
            rows={6}
            maxLength={1000}
            className={styles.textarea}
            aria-invalid={Boolean(errors.prompt)}
            aria-describedby="prompt-error"
          />
          <p id="prompt-error" className={styles.errorText} data-testid="goal-error">
            {errors.prompt?.message}
          </p>
        </div>
        <div className={styles.buttonGroup}>
          <span />
          <button type="button" className={styles.nextButton} onClick={() => void goNext()}>
            {t('task.wizard.next')}
          </button>
        </div>
      </WizardStep>

      <WizardStep isActive={currentStep === 2}>
        <h2 className={styles.stepTitle}>{stepTitles.agents}</h2>
        <div className={styles.field}>
          <span id="agentPreferences-label" className={styles.label}>
            {t('task.submit.preferencesLabel')}
          </span>
          <Controller
            control={control}
            name="agentPreferences"
            render={({ field }) => renderAgentSelectors(field)}
          />
          <div aria-live="polite" id="agentPreferences-error" data-testid="agents-error">
            {errors.agentPreferences && (
              <p className={styles.agentError}>
                <AlertCircle size={16} />
                {errors.agentPreferences.message}
              </p>
            )}
          </div>
        </div>
        <div className={styles.buttonGroup}>
          <button type="button" className={styles.backButton} onClick={goBack}>
            {t('task.wizard.back')}
          </button>
          <button type="button" className={styles.nextButton} onClick={() => void goNext()}>
            {t('task.wizard.next')}
          </button>
        </div>
      </WizardStep>

      <WizardStep isActive={currentStep === 3}>
        <h2 className={styles.stepTitle}>{stepTitles.review}</h2>

        <div className={styles.field}>
          <label htmlFor="maxBudgetXLM" className={styles.label}>
            {t('task.submit.budgetLabel')}
          </label>
          <input
            id="maxBudgetXLM"
            type="number"
            step="0.1"
            min="0.1"
            {...register('maxBudgetXLM', { valueAsNumber: true })}
            className={styles.budgetInput}
            aria-invalid={Boolean(errors.maxBudgetXLM)}
            aria-describedby="budget-error"
          />
          <p
            id="budget-error"
            className={errors.maxBudgetXLM ? styles.errorText : styles.budgetHelper}
            data-testid="budget-error"
          >
            {budgetHelperText}
          </p>
        </div>

        <div className={styles.field}>
          <h3 className={styles.sectionTitle}>{t('task.submit.dagTitle')}</h3>
          <div id="dag-preview">
            <DAGPreview dagPreview={liveDag.nodes.length > 0 ? liveDag : undefined} />
          </div>
        </div>

        <div className={styles.buttonGroup}>
          <button type="button" className={styles.backButton} onClick={goBack}>
            {t('task.wizard.back')}
          </button>
          <button type="button" className={styles.nextButton} onClick={() => void goNext()}>
            {t('task.wizard.next')}
          </button>
        </div>
      </WizardStep>

      <WizardStep isActive={currentStep === 4}>
        <h2 className={styles.stepTitle}>{stepTitles.submit}</h2>

        <form onSubmit={handleSubmit(onSubmit)} noValidate id="task-form">
          <dl className={styles.summary}>
            <div className={styles.summaryRow}>
              <dt>{t('task.submit.promptLabel')}</dt>
              <dd data-testid="summary-prompt">
                {watchedValues.prompt || t('task.wizard.summary.noPrompt')}
              </dd>
            </div>
            <div className={styles.summaryRow}>
              <dt>{t('task.submit.preferencesLabel')}</dt>
              <dd data-testid="summary-agents">
                {selectedPreferences && selectedPreferences.length > 0
                  ? selectedPreferences.map((p) => labelOf(p)).join(', ')
                  : t('task.wizard.summary.noAgents')}
              </dd>
            </div>
            <div className={styles.summaryRow}>
              <dt>{t('task.submit.budgetLabel')}</dt>
              <dd data-testid="summary-budget">
                {typeof watchedValues.maxBudgetXLM === 'number'
                  ? watchedValues.maxBudgetXLM.toFixed(2)
                  : '0.10'}{' '}
                XLM
              </dd>
            </div>
          </dl>

          <div className={styles.buttonGroup}>
            <button type="button" className={styles.backButton} onClick={goBack}>
              {t('task.wizard.back')}
            </button>
            <button type="submit" id="btn-submit-task" className={styles.submitButton} disabled={isLoading}>
              {isLoading ? t('task.submit.submitting') : t('task.submit.submit')}
            </button>
          </div>
        </form>

        {status === 'success' && (
          <span className={styles.successText}>{t('task.submit.success')}</span>
        )}
      </WizardStep>

      {error && (
        <div role="status" className={styles.errorBanner}>
          {error}
        </div>
      )}
    </main>
  );
}
