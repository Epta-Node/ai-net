import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import i18n from 'i18next';
import { ToastProvider } from '../../context/ToastContext';
import { TaskSubmissionForm } from './TaskSubmissionForm';

vi.mock('./DAGPreview', () => ({
  DAGPreview: () => <div data-testid="dag-preview" />,
}));

const renderForm = () =>
  render(
    <ToastProvider>
      <MemoryRouter initialEntries={['/tasks/new']}>
        <TaskSubmissionForm />
      </MemoryRouter>
    </ToastProvider>
  );

const switchTo = async (language: string) => {
  await act(async () => {
    await i18n.changeLanguage(language);
  });
};

describe('TaskSubmissionForm i18n', () => {
  afterEach(async () => {
    await switchTo('en');
  });

  it('translates the headings, the field labels and the submit button', async () => {
    renderForm();

    expect(screen.getByRole('heading', { name: 'Submit a New Task' })).toBeInTheDocument();
    expect(screen.getByLabelText('Task prompt')).toBeInTheDocument();
    expect(screen.getByLabelText('Maximum budget (XLM)')).toBeInTheDocument();
    expect(screen.getByText('Agent preferences')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Submit task' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Execution DAG preview' })).toBeInTheDocument();

    await switchTo('zh');

    expect(screen.getByRole('heading', { name: '提交新任务' })).toBeInTheDocument();
    expect(screen.getByLabelText('任务提示词')).toBeInTheDocument();
    expect(screen.getByLabelText('最高预算 (XLM)')).toBeInTheDocument();
    expect(screen.getByText('智能体偏好')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '提交任务' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '执行 DAG 预览' })).toBeInTheDocument();
  });

  it('translates the agent preference labels but keeps the checkbox values in English', async () => {
    renderForm();

    const research = screen.getByLabelText('Research Agent') as HTMLInputElement;
    expect(research.value).toBe('research');

    await switchTo('zh');

    const translated = screen.getByLabelText('研究智能体') as HTMLInputElement;
    // The wire format the API and the zod enum rely on must not be translated.
    expect(translated.value).toBe('research');
    expect(screen.getByLabelText('风险智能体')).toBeInTheDocument();
    expect(screen.getByLabelText('编码智能体')).toBeInTheDocument();
    expect(screen.getByLabelText('设计智能体')).toBeInTheDocument();
    expect(screen.getByLabelText('报告智能体')).toBeInTheDocument();
  });

  it('re-renders zod validation messages already on screen in the new language', async () => {
    renderForm();

    fireEvent.click(screen.getByRole('button', { name: 'Submit task' }));

    expect(await screen.findByText('Prompt is required')).toBeInTheDocument();
    expect(screen.getByText('Choose at least one agent')).toBeInTheDocument();

    await switchTo('zh');

    await waitFor(() => expect(screen.getByText('提示词为必填项')).toBeInTheDocument());
    expect(screen.getByText('请至少选择一个智能体')).toBeInTheDocument();
  });

  it('translates the budget helper text shown when there is no error', async () => {
    renderForm();

    expect(screen.getByText('Budget must be at least 0.1 XLM.')).toBeInTheDocument();

    await switchTo('zh');

    expect(screen.getByText('预算至少为 0.1 XLM。')).toBeInTheDocument();
  });
});
