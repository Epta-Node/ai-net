import { render, screen, waitFor, act } from '@testing-library/react';
import { vi } from 'vitest';
import i18n from 'i18next';
import { RecentTasksTable } from './RecentTasksTable';
import { ToastProvider } from '../../context/ToastContext';
import type { TaskResponse } from '../../types/api';

const getRecentTasks = vi.hoisted(() => vi.fn());
vi.mock('@services/api', () => ({ getRecentTasks }));

const WALLET = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRXYZ';

const task: TaskResponse = {
  taskId: 'abcd1234-ef56-7890-abcd-ef1234567890',
  id: 'abcd1234-ef56-7890-abcd-ef1234567890',
  prompt: 'Build something',
  walletPublicKey: WALLET,
  status: 'completed',
  dag: [],
  createdAt: '2026-08-22T10:00:00.000Z',
  updatedAt: '2026-08-22T10:05:00.000Z',
};

const renderTable = () =>
  render(
    <ToastProvider>
      <RecentTasksTable walletAddress={WALLET} loading={false} />
    </ToastProvider>
  );

describe('RecentTasksTable i18n', () => {
  afterEach(async () => {
    vi.clearAllMocks();
    await act(async () => {
      await i18n.changeLanguage('en');
    });
  });

  it('translates the column headers and the view link', async () => {
    getRecentTasks.mockResolvedValue([task]);
    renderTable();

    await waitFor(() => expect(screen.getByText('Task ID')).toBeInTheDocument());
    expect(screen.getByText('Created')).toBeInTheDocument();
    expect(screen.getByText('Action')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View' })).toBeInTheDocument();

    await act(async () => {
      await i18n.changeLanguage('zh');
    });

    expect(screen.getByText('任务 ID')).toBeInTheDocument();
    expect(screen.getByText('创建时间')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '查看' })).toBeInTheDocument();
  });

  it('leaves the task status untranslated, because it is data', async () => {
    getRecentTasks.mockResolvedValue([task]);
    renderTable();

    await waitFor(() => expect(screen.getByText('completed')).toBeInTheDocument());

    await act(async () => {
      await i18n.changeLanguage('zh');
    });

    expect(screen.getByText('completed')).toBeInTheDocument();
  });

  it('translates the empty state', async () => {
    getRecentTasks.mockResolvedValue([]);
    renderTable();

    await waitFor(() =>
      expect(screen.getByText('No recent tasks for this wallet.')).toBeInTheDocument()
    );

    await act(async () => {
      await i18n.changeLanguage('zh');
    });

    expect(screen.getByText('此钱包暂无最近任务。')).toBeInTheDocument();
  });

  it('formats the created date for the active language, not the browser locale', async () => {
    getRecentTasks.mockResolvedValue([task]);
    renderTable();

    // Patterns rather than exact strings: without a `timeZone` option the
    // helper uses the machine's timezone, so the hour is not portable to CI.
    await waitFor(() =>
      expect(screen.getByText(/^\d{1,2}\/\d{1,2}\/2026, /)).toBeInTheDocument()
    );

    await act(async () => {
      await i18n.changeLanguage('zh');
    });

    // Chinese puts the year first — proof the switcher drives the format.
    expect(screen.getByText(/^2026\/\d{1,2}\/\d{1,2} /)).toBeInTheDocument();
  });

  it('shows the fetch error toast in the language active when it fires', async () => {
    getRecentTasks.mockRejectedValue(new Error('boom'));
    await act(async () => {
      await i18n.changeLanguage('zh');
    });
    renderTable();

    await waitFor(() => expect(screen.getByText('获取最近任务失败')).toBeInTheDocument());
  });
});
