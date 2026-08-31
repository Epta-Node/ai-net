import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import CopyButton from '../common/CopyButton';
import CollapsibleSection from '../common/CollapsibleSection';
import AgentOutputRenderer from './AgentOutputRenderer';
import ResearchReportRenderer from './ResearchReportRenderer';

// Mock navigator.clipboard
Object.assign(navigator, {
  clipboard: {
    writeText: vi.fn().mockImplementation(() => Promise.resolve()),
  },
});

describe('CopyButton Component', () => {
  it('renders copy button and shows checkmark feedback when clicked', async () => {
    render(<CopyButton text="const a = 10;" label="Copy Code" />);

    const button = screen.getByTestId('copy-button');
    expect(button).toHaveTextContent('Copy Code');

    fireEvent.click(button);

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('const a = 10;');

    await waitFor(() => {
      expect(screen.getByTestId('copy-button')).toHaveTextContent('✓ Copied!');
    });
  });
});

describe('CollapsibleSection Component', () => {
  it('auto-collapses when content length is greater than 500 chars', () => {
    const longContent = 'A'.repeat(600);
    render(
      <CollapsibleSection title="Long Section" contentLength={longContent.length}>
        <div>{longContent}</div>
      </CollapsibleSection>
    );

    expect(screen.getByTestId('collapsible-section')).toBeInTheDocument();
    expect(screen.queryByTestId('collapsible-content')).not.toBeInTheDocument();
    expect(screen.getByText('600 chars')).toBeInTheDocument();
  });

  it('expands content when header is clicked', () => {
    const longContent = 'B'.repeat(600);
    render(
      <CollapsibleSection title="Long Section" contentLength={longContent.length}>
        <div data-testid="expanded-text">{longContent}</div>
      </CollapsibleSection>
    );

    const header = screen.getByTestId('collapsible-header');
    fireEvent.click(header);

    expect(screen.getByTestId('collapsible-content')).toBeInTheDocument();
    expect(screen.getByTestId('expanded-text')).toBeInTheDocument();
  });
});

describe('ResearchReportRenderer', () => {
  it('renders code blocks, tables, and external links with target="_blank"', async () => {
    const markdownResult = `
# Report Header
[Google](https://google.com)

\`\`\`javascript
const x = 42;
\`\`\`

| Header 1 | Header 2 |
| -------- | -------- |
| Val 1    | Val 2    |
`;

    render(<ResearchReportRenderer result={markdownResult} />);

    await waitFor(() => {
      expect(screen.getByTestId('external-link')).toHaveAttribute('target', '_blank');
      expect(screen.getByTestId('external-link')).toHaveAttribute('rel', 'noopener noreferrer');
      expect(screen.getByTestId('code-block')).toBeInTheDocument();
      expect(screen.getByTestId('markdown-table')).toBeInTheDocument();
    });
  });
});

describe('AgentOutputRenderer Header, Search, and Full-Screen Mode', () => {
  it('renders header with agent name, execution time, and token count', () => {
    render(
      <AgentOutputRenderer
        agentType="risk"
        result={[]}
        agentName="Custom Risk"
        executionTimeMs={1500}
        tokenCount={1200}
      />
    );

    expect(screen.getByTestId('agent-name')).toHaveTextContent('Custom Risk');
    expect(screen.getByTestId('execution-time')).toHaveTextContent('1.50s');
    expect(screen.getByTestId('token-count')).toHaveTextContent('1,200 tokens');
  });

  it('toggles full-screen overlay mode', () => {
    render(
      <AgentOutputRenderer
        agentType="risk"
        result={[]}
      />
    );

    expect(screen.queryByTestId('fullscreen-output-overlay')).not.toBeInTheDocument();

    const fullscreenBtn = screen.getByTestId('fullscreen-toggle-btn');
    fireEvent.click(fullscreenBtn);

    expect(screen.getByTestId('fullscreen-output-overlay')).toBeInTheDocument();
  });

  it('filters content using search input', async () => {
    render(
      <AgentOutputRenderer
        agentType="coding"
        result="function hello() { return 'world'; }"
      />
    );

    const searchInput = screen.getByTestId('output-search-input');
    fireEvent.change(searchInput, { target: { value: 'nonexistent' } });

    await waitFor(() => {
      expect(screen.getByText(/No code matching search filter/i)).toBeInTheDocument();
    });
  });
});
