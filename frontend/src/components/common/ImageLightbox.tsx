import React, { useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  X,
  ChevronLeft,
  ChevronRight,
  Download,
  ZoomIn,
  ZoomOut,
  RotateCcw
} from 'lucide-react';
import { LightboxImage } from '../../hooks/useLightbox';
import styles from './ImageLightbox.module.css';

export interface ImageLightboxProps {
  isOpen: boolean;
  images: LightboxImage[];
  currentIndex: number;
  scale?: number;
  position?: { x: number; y: number };
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  onSelectIndex: (index: number) => void;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onResetZoom?: () => void;
  onWheel?: (e: React.WheelEvent | WheelEvent) => void;
  onPinch?: (scaleDelta: number) => void;
  onPositionChange?: (pos: { x: number; y: number }) => void;
}

export const ImageLightbox: React.FC<ImageLightboxProps> = ({
  isOpen,
  images,
  currentIndex,
  scale = 1,
  position = { x: 0, y: 0 },
  onClose,
  onPrev,
  onNext,
  onSelectIndex,
  onZoomIn,
  onZoomOut,
  onResetZoom,
  onWheel,
  onPinch,
  onPositionChange
}) => {
  const touchDistanceRef = useRef<number | null>(null);

  const currentImage = images[currentIndex] || null;

  // Keyboard navigation
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'ArrowLeft') {
        onPrev();
      } else if (e.key === 'ArrowRight') {
        onNext();
      } else if (e.key === '+' || e.key === '=') {
        onZoomIn?.();
      } else if (e.key === '-') {
        onZoomOut?.();
      } else if (e.key === '0') {
        onResetZoom?.();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose, onPrev, onNext, onZoomIn, onZoomOut, onResetZoom]);

  // Touch Pinch gesture handling
  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      touchDistanceRef.current = dist;
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 2 && touchDistanceRef.current !== null) {
      const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      const delta = (dist - touchDistanceRef.current) / 150;
      touchDistanceRef.current = dist;
      onPinch?.(delta);
    }
  };

  const handleTouchEnd = () => {
    touchDistanceRef.current = null;
  };

  // Image Download
  const handleDownload = async () => {
    if (!currentImage) return;
    try {
      const response = await fetch(currentImage.url);
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = currentImage.title || `design-output-${currentIndex + 1}.png`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(blobUrl);
    } catch {
      const link = document.createElement('a');
      link.href = currentImage.url;
      link.download = currentImage.title || `design-output-${currentIndex + 1}.png`;
      link.target = '_blank';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  };

  if (!isOpen || !currentImage) return null;

  const formattedScale = `${Math.round(scale * 100)}%`;

  return (
    <AnimatePresence>
      <motion.div
        className={styles.overlay}
        data-testid="lightbox-overlay"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        {/* Header / Toolbar */}
        <div className={styles.header} data-testid="lightbox-header">
          <div className={styles.titleArea}>
            {images.length > 0 && (
              <span className={styles.counterBadge} data-testid="image-counter">
                {currentIndex + 1} / {images.length}
              </span>
            )}
            {currentImage.title && (
              <span className={styles.imageTitle} title={currentImage.title}>
                {currentImage.title}
              </span>
            )}
          </div>

          <div className={styles.toolbar}>
            {onZoomOut && (
              <button
                className={styles.iconBtn}
                onClick={onZoomOut}
                title="Zoom Out (-)"
                data-testid="zoom-out-btn"
                disabled={scale <= 1}
              >
                <ZoomOut size={18} />
              </button>
            )}

            {onResetZoom && (
              <button
                className={styles.iconBtn}
                onClick={onResetZoom}
                title="Reset Zoom (0)"
                data-testid="zoom-reset-btn"
              >
                <RotateCcw size={16} style={{ marginRight: 6 }} />
                <span>{formattedScale}</span>
              </button>
            )}

            {onZoomIn && (
              <button
                className={styles.iconBtn}
                onClick={onZoomIn}
                title="Zoom In (+)"
                data-testid="zoom-in-btn"
              >
                <ZoomIn size={18} />
              </button>
            )}

            <button
              className={styles.iconBtn}
              onClick={handleDownload}
              title="Download Image"
              data-testid="download-btn"
            >
              <Download size={18} />
            </button>

            <button
              className={`${styles.iconBtn} ${styles.closeBtn}`}
              onClick={onClose}
              title="Close Lightbox (Esc)"
              data-testid="close-btn"
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Main Viewing Stage */}
        <div
          className={styles.mainStage}
          onWheel={onWheel}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          onClick={(e) => {
            if (e.target === e.currentTarget) onClose();
          }}
        >
          {/* Navigation Chevron Left */}
          {images.length > 1 && (
            <button
              className={`${styles.navBtn} ${styles.navBtnLeft}`}
              onClick={(e) => {
                e.stopPropagation();
                onPrev();
              }}
              title="Previous Image (Left Arrow)"
              data-testid="prev-btn"
            >
              <ChevronLeft size={24} />
            </button>
          )}

          {/* Draggable & Zoomable Image Wrapper */}
          <div className={styles.imageWrapper}>
            <motion.img
              key={currentImage.url}
              src={currentImage.url}
              alt={currentImage.alt || currentImage.title || 'Design asset'}
              className={styles.lightboxImage}
              data-testid="lightbox-image"
              drag={scale > 1}
              dragConstraints={{ left: -1000, right: 1000, top: -1000, bottom: 1000 }}
              dragElastic={0.1}
              animate={{
                scale: scale,
                x: scale > 1 ? position.x : 0,
                y: scale > 1 ? position.y : 0
              }}
              onDragEnd={(_, info) => {
                if (scale > 1 && onPositionChange) {
                  onPositionChange({
                    x: position.x + info.offset.x,
                    y: position.y + info.offset.y
                  });
                }
              }}
              transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            />
          </div>

          {/* Navigation Chevron Right */}
          {images.length > 1 && (
            <button
              className={`${styles.navBtn} ${styles.navBtnRight}`}
              onClick={(e) => {
                e.stopPropagation();
                onNext();
              }}
              title="Next Image (Right Arrow)"
              data-testid="next-btn"
            >
              <ChevronRight size={24} />
            </button>
          )}
        </div>

        {/* Thumbnails Bar (for multi-image outputs) */}
        {images.length > 1 && (
          <div className={styles.thumbnailsBar} data-testid="thumbnails-bar">
            {images.map((img, idx) => (
              <div
                key={`${img.url}-${idx}`}
                className={`${styles.thumbItem} ${idx === currentIndex ? styles.thumbActive : ''}`}
                onClick={() => onSelectIndex(idx)}
                data-testid={`thumb-${idx}`}
              >
                <img src={img.url} alt={img.title || `Thumb ${idx + 1}`} className={styles.thumbImg} />
              </div>
            ))}
          </div>
        )}
      </motion.div>
    </AnimatePresence>
  );
};

export default ImageLightbox;
