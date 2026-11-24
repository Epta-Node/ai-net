import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import i18n from 'i18next';
import { ToastProvider } from '../../context/ToastContext';
import { TaskSubmissionForm } from './TaskSubmissionForm';

vi.mock('../../context/ToastContext', () => ({
  ToastProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useToast: () => ({ showToast: vi.fn() }),
}));

vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  },
}));

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
    window.localStorage.clear();
    await switchTo('en');
  });

  it('translates the title, the step-1 headings, field label and the wizard button', async () => {
    renderForm();

    expect(screen.getByRole('heading', { name: 'Submit a New Task' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Describe your goal' })).toBeInTheDocument();
    expect(screen.getByLabelText('Task prompt')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeInTheDocument();

    await switchTo('zh');

    expect(screen.getByRole('heading', { name: '提交新任务' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '描述你的目标' })).toBeInTheDocument();
    expect(screen.getByLabelText('任务提示词')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下一步' })).toBeInTheDocument();
  });

  it('translates the agent preference labels but keeps the checkbox values in English', async () => {
    renderForm();
    // Advance to step 2 with a valid goal.
    fireEvent.change(screen.getByLabelText(/task prompt/i), {
      target: { value: 'Build a report' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    const research = (await screen.findByLabelText('Research Agent')) as HTMLInputElement;
    expect(research.value).toBe('research');

    await switchTo('zh');

    const translated = screen.getByLabelText('研究智能体') as HTMLInputElement;
    expect(translated.value).toBe('research');
    expect(screen.getByLabelText('风险智能体')).toBeInTheDocument();
    expect(screen.getByLabelText('编码智能体')).toBeInTheDocument();
    expect(screen.getByLabelText('设计智能体')).toBeInTheDocument();
    expect(screen.getByLabelText('报告智能体')).toBeInTheDocument();
  });

  it('renders zod validation messages in the active language', async () => {
    await switchTo('zh');
    renderForm();

    fireEvent.click(screen.getByRole('button', { name: '下一步' }));

    expect(await screen.findByText('提示词为必填项')).toBeInTheDocument();
  });

  it('translates the review-step heading and budget helper text', async () => {
    renderForm();
    fireEvent.change(screen.getByLabelText(/task prompt/i), {
      target: { value: 'Build a report' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('heading', { name: 'Choose agents & capabilities' });
    fireEvent.click(screen.getByLabelText('Research Agent'));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('heading', { name: 'Review budget & DAG' });

    expect(screen.getByText('Budget must be at least 0.1 XLM.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Execution DAG preview' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Describe your goal' })).not.toBeInTheDocument();

    await switchTo('zh');

    expect(screen.getByText('预算至少为 0.1 XLM。')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '执行 DAG 预览' })).toBeInTheDocument();
  });
});
