import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import AgentCard from './AgentCard';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}));

describe('AgentCard Component', () => {
  const mockAgent = {
    id: 'agent-1',
    name: 'Research Specialist',
    type: 'Research',
    description: 'Conducts deep-dive market and technical research.',
    icon: <span>🔍</span>,
    tasksCompleted: 42,
    successRate: 98,
    capabilities: ['research', 'report'],
    isOnline: true,
    reputation: 95,
  };

  it('renders agent details correctly', () => {
    render(<AgentCard agent={mockAgent} index={0} />);
    expect(screen.getByText('Research Specialist')).toBeInTheDocument();
    expect(screen.getByText('Research')).toBeInTheDocument();
    expect(screen.getByTitle('research')).toHaveClass('text-[var(--agent-research)]');
    expect(screen.getByTitle('report')).toHaveClass('text-[var(--agent-report)]');
  });
});
