/**
 * @vitest-environment jsdom
 */

import { render, screen } from '@testing-library/react';
import { describe, test, expect } from 'vitest';
import '@testing-library/jest-dom';
import { KpiCard } from './KpiCard';

// Recharts uses SVG render which JSDOM doesn't support natively,
// but the ResponsiveContainer wrapper still renders the parent div.
// We test the structural output rather than the SVG internals.

describe('KpiCard Component', () => {
  test('renders title and numeric value', () => {
    render(<KpiCard title="Total Agents" value={42} sparklineData={[1, 2, 3]} />);
    expect(screen.getByText('Total Agents')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Total Agents: 42' })).toBeInTheDocument();
  });

  test('renders non-numeric value (percentage) as-is', () => {
    render(<KpiCard title="Network Uptime" value="99.97%" sparklineData={[98, 99, 100]} />);
    expect(screen.getByText('Network Uptime')).toBeInTheDocument();
    expect(screen.getByText('99.97%')).toBeInTheDocument();
  });

  test('shows skeleton placeholder when loading', () => {
    const { container } = render(
      <KpiCard title="Total Agents" value={0} sparklineData={[]} loading />
    );
    expect(container.querySelector('[class*="skeleton"]')).toBeInTheDocument();
  });

  test('shows muted dash for zero value', () => {
    render(<KpiCard title="Total Agents" value={0} sparklineData={[0, 0, 0]} />);
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Total Agents: no data' })).toBeInTheDocument();
  });

  test('renders sparkline container', () => {
    const { container } = render(
      <KpiCard title="Total Tasks" value={10} sparklineData={[1, 2, 3, 4, 5]} />
    );
    const sparklineContainer = container.querySelector('[class*="sparkline"]');
    expect(sparklineContainer).toBeInTheDocument();
  });
});