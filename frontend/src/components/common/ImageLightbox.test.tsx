import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ImageLightbox from './ImageLightbox';
import DesignRenderer from '../agents/DesignRenderer';

const mockImages = [
  { url: 'https://example.com/image1.png', title: 'Dashboard Wireframe', alt: 'Dashboard' },
  { url: 'https://example.com/image2.png', title: 'Settings Mockup', alt: 'Settings' },
  { url: 'https://example.com/image3.png', title: 'Profile Screen', alt: 'Profile' },
];

describe('ImageLightbox', () => {
  it('does not render when isOpen is false', () => {
    render(
      <ImageLightbox
        isOpen={false}
        images={mockImages}
        currentIndex={0}
        onClose={vi.fn()}
        onPrev={vi.fn()}
        onNext={vi.fn()}
        onSelectIndex={vi.fn()}
      />
    );

    expect(screen.queryByTestId('lightbox-overlay')).not.toBeInTheDocument();
  });

  it('renders lightbox overlay and image counter "2 / 3" when open', () => {
    render(
      <ImageLightbox
        isOpen={true}
        images={mockImages}
        currentIndex={1}
        onClose={vi.fn()}
        onPrev={vi.fn()}
        onNext={vi.fn()}
        onSelectIndex={vi.fn()}
      />
    );

    expect(screen.getByTestId('lightbox-overlay')).toBeInTheDocument();
    expect(screen.getByTestId('image-counter')).toHaveTextContent('2 / 3');
    expect(screen.getByText('Settings Mockup')).toBeInTheDocument();

    const mainImg = screen.getByTestId('lightbox-image');
    expect(mainImg).toHaveAttribute('src', 'https://example.com/image2.png');
  });

  it('calls onClose when close button (X) is clicked', () => {
    const handleClose = vi.fn();
    render(
      <ImageLightbox
        isOpen={true}
        images={mockImages}
        currentIndex={0}
        onClose={handleClose}
        onPrev={vi.fn()}
        onNext={vi.fn()}
        onSelectIndex={vi.fn()}
      />
    );

    const closeBtn = screen.getByTestId('close-btn');
    fireEvent.click(closeBtn);

    expect(handleClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when Esc key is pressed', () => {
    const handleClose = vi.fn();
    render(
      <ImageLightbox
        isOpen={true}
        images={mockImages}
        currentIndex={0}
        onClose={handleClose}
        onPrev={vi.fn()}
        onNext={vi.fn()}
        onSelectIndex={vi.fn()}
      />
    );

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(handleClose).toHaveBeenCalledTimes(1);
  });

  it('navigates with ArrowLeft and ArrowRight keys', () => {
    const handlePrev = vi.fn();
    const handleNext = vi.fn();
    render(
      <ImageLightbox
        isOpen={true}
        images={mockImages}
        currentIndex={1}
        onClose={vi.fn()}
        onPrev={handlePrev}
        onNext={handleNext}
        onSelectIndex={vi.fn()}
      />
    );

    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(handlePrev).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(handleNext).toHaveBeenCalledTimes(1);
  });

  it('navigates when clicking previous and next buttons', () => {
    const handlePrev = vi.fn();
    const handleNext = vi.fn();
    render(
      <ImageLightbox
        isOpen={true}
        images={mockImages}
        currentIndex={1}
        onClose={vi.fn()}
        onPrev={handlePrev}
        onNext={handleNext}
        onSelectIndex={vi.fn()}
      />
    );

    fireEvent.click(screen.getByTestId('prev-btn'));
    expect(handlePrev).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('next-btn'));
    expect(handleNext).toHaveBeenCalledTimes(1);
  });

  it('triggers zoomIn and zoomOut callbacks', () => {
    const handleZoomIn = vi.fn();
    const handleZoomOut = vi.fn();
    render(
      <ImageLightbox
        isOpen={true}
        images={mockImages}
        currentIndex={0}
        scale={2}
        onClose={vi.fn()}
        onPrev={vi.fn()}
        onNext={vi.fn()}
        onSelectIndex={vi.fn()}
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
      />
    );

    fireEvent.click(screen.getByTestId('zoom-in-btn'));
    expect(handleZoomIn).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('zoom-out-btn'));
    expect(handleZoomOut).toHaveBeenCalledTimes(1);
  });

  it('calls onSelectIndex when clicking thumbnail', () => {
    const handleSelect = vi.fn();
    render(
      <ImageLightbox
        isOpen={true}
        images={mockImages}
        currentIndex={0}
        onClose={vi.fn()}
        onPrev={vi.fn()}
        onNext={vi.fn()}
        onSelectIndex={handleSelect}
      />
    );

    fireEvent.click(screen.getByTestId('thumb-2'));
    expect(handleSelect).toHaveBeenCalledWith(2);
  });
});

describe('DesignRenderer with ImageLightbox integration', () => {
  it('renders design images gallery and opens lightbox when clicking card', () => {
    const result = {
      images: [
        { url: 'https://example.com/design1.png', title: 'Homepage Mockup' },
        { url: 'https://example.com/design2.png', title: 'User Profile' }
      ]
    };

    render(<DesignRenderer result={result} />);

    expect(screen.getByTestId('design-images-gallery')).toBeInTheDocument();
    expect(screen.getByText('Design Outputs & Wireframes (2)')).toBeInTheDocument();

    const firstCard = screen.getByTestId('design-image-card-0');
    fireEvent.click(firstCard);

    // Lightbox should now be open
    expect(screen.getByTestId('lightbox-overlay')).toBeInTheDocument();
    expect(screen.getByTestId('image-counter')).toHaveTextContent('1 / 2');
    expect(screen.getAllByText('Homepage Mockup').length).toBeGreaterThanOrEqual(1);
  });
});
