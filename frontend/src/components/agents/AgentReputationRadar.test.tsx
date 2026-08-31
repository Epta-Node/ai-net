import React from 'react';
import { render } from '@testing-library/react';
import { AgentReputationRadar } from './AgentReputationRadar';
import { vi, describe, it, expect } from 'vitest';

// ResponsiveContainer measures its parent, and jsdom reports 0x0 for
// everything — so the real one renders a chart of zero size, which recharts
// skips entirely. The stand-in hands the chart concrete pixel dimensions;
// passing them down is the part that actually makes the chart render, since a
// RadarChart with no width/height draws nothing.
vi.mock('recharts', async () => {
  const OriginalRecharts = await vi.importActual<any>('recharts');
  return {
    ...OriginalRecharts,
    ResponsiveContainer: ({ children }: any) => (
      <div style={{ width: 400, height: 250 }}>
        {React.cloneElement(React.Children.only(children), { width: 400, height: 250 })}
      </div>
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
