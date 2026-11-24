import { render, screen, act } from '@testing-library/react';
import i18n from 'i18next';
import { RecentTasksTable } from './RecentTasksTable';
import { ToastProvider } from '../../context/ToastContext';

const WALLET = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRXYZ';

const renderTable = () =>
  render(
    <ToastProvider>
      <RecentTasksTable walletAddress={WALLET} loading={false} />
    </ToastProvider>
  );

describe('RecentTasksTable i18n', () => {
  afterEach(async () => {
    await act(async () => {
      await i18n.changeLanguage('en');
    });
  });

  it('renders empty state since the API endpoint does not exist', () => {
    renderTable();

    expect(screen.getByText('No recent tasks for this wallet.')).toBeInTheDocument();
    expect(screen.getByText('Submit a new multi-agent task to begin orchestration on the AI Network.')).toBeInTheDocument();
  });

  it('translates the empty state', async () => {
    renderTable();

    expect(screen.getByText('No recent tasks for this wallet.')).toBeInTheDocument();

    await act(async () => {
      await i18n.changeLanguage('zh');
    });

    expect(screen.getByText('此钱包暂无最近任务。')).toBeInTheDocument();
  });
});
