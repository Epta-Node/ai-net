import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import Hero from './Hero';
import { useTypingAnimation } from '../../hooks/useTypingAnimation';
import { useParticles } from '../../hooks/useParticles';

vi.mock('../../hooks/useTypingAnimation');
vi.mock('../../hooks/useParticles');

const mockUseTypingAnimation = vi.mocked(useTypingAnimation);
const mockUseParticles = vi.mocked(useParticles);

describe('Hero Component', () => {
  beforeEach(() => {
    mockUseTypingAnimation.mockReturnValue('Research');
    mockUseParticles.mockReturnValue({
      canvasRef: { current: null },
      prefersReducedMotion: false,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const renderComponent = () => {
    return render(
      <BrowserRouter>
        <Hero />
      </BrowserRouter>
    );
  };

  it('renders typing animation text', () => {
    renderComponent();
    expect(screen.getByText('Research')).toBeInTheDocument();
  });

  it('renders canvas when prefersReducedMotion is false', () => {
    const { container } = renderComponent();
    const canvas = container.querySelector('canvas');
    expect(canvas).toBeInTheDocument();
  });

  it('renders fallback gradient when prefersReducedMotion is true', () => {
    mockUseParticles.mockReturnValue({
      canvasRef: { current: null },
      prefersReducedMotion: true,
    });
    
    const { container } = renderComponent();
    const canvas = container.querySelector('canvas');
    expect(canvas).not.toBeInTheDocument();
    
    // Fallback div should be rendered (we check by class or element type if specific)
    const fallbackDiv = container.querySelector('.staticGradient');
    expect(fallbackDiv).toBeInTheDocument();
  });
});
