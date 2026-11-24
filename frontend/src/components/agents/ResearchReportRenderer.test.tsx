import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ResearchReportRenderer from './ResearchReportRenderer';

const report = `
## Market Overview
Stellar payments volume grew steadily across the quarter.

## Risks
Liquidity remains thin on smaller anchors.
`;

describe('ResearchReportRenderer search filter', () => {
  it('renders the report when no search query is given', async () => {
    render(<ResearchReportRenderer result={report} />);

    expect(await screen.findByTestId('research-markdown')).toHaveTextContent(
      'Market Overview',
    );
  });

  it('renders the report when the search query matches its content', async () => {
    render(<ResearchReportRenderer result={report} searchQuery="LIQUIDITY" />);

    const body = await screen.findByTestId('research-markdown');
    expect(body).toHaveTextContent('Liquidity remains thin on smaller anchors.');
    expect(screen.queryByText(/No report content matching/)).not.toBeInTheDocument();
  });

  it('shows the no-match message instead of the report when nothing matches', () => {
    render(<ResearchReportRenderer result={report} searchQuery="bitcoin" />);

    expect(
      screen.getByText('No report content matching search filter "bitcoin".'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('research-markdown')).not.toBeInTheDocument();
  });

  it('matches against markdown built from a structured result', async () => {
    render(
      <ResearchReportRenderer
        result={{ summary: 'Anchors are consolidating.', keyFindings: ['Fees fell 12%'] }}
        searchQuery="fees fell"
      />,
    );

    expect(await screen.findByTestId('research-markdown')).toHaveTextContent('Fees fell 12%');
  });
});
