import { render } from '@testing-library/react';
import { AgentReputationRadar } from './AgentReputationRadar';
import { vi, describe, it, expect } from 'vitest';

// Mock recharts because ResponsiveContainer doesn't work well in JSDOM
vi.mock('recharts', async () => {
  const OriginalRecharts = await vi.importActual<any>('recharts');
  return {
    ...OriginalRecharts,
    ResponsiveContainer: ({ children }: any) => (
      <div className="recharts-wrapper" style={{ width: '100%', height: 250 }}>{children}</div>
    ),
  };
});

describe('AgentReputationRadar', () => {
  it('renders the radar chart with given dimensions', () => {
    const dimensions = {
      quality: 90,
      speed: 85,
      reliability: 95,
      cost: 80,
    };

    const { container } = render(<AgentReputationRadar dimensions={dimensions} />);
    
    // Check if the container is rendered
    expect(container.firstChild).toBeInTheDocument();
    
    // In a real JSDOM environment with SVG, we could check for specific SVG elements.
    // For this test, we ensure it renders without crashing and contains the ResponsiveContainer div.
    expect(container.querySelector('.recharts-wrapper')).toBeInTheDocument();
  });
});
