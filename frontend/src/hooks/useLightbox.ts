import { useState, useCallback } from 'react';

export interface LightboxImage {
  url: string;
  title?: string;
  alt?: string;
}

export interface UseLightboxReturn {
  isOpen: boolean;
  images: LightboxImage[];
  currentIndex: number;
  currentImage: LightboxImage | null;
  scale: number;
  position: { x: number; y: number };
  openLightbox: (imageList: (string | LightboxImage)[], initialIndex?: number) => void;
  closeLightbox: () => void;
  nextImage: () => void;
  prevImage: () => void;
  setIndex: (index: number) => void;
  zoomIn: (step?: number) => void;
  zoomOut: (step?: number) => void;
  resetZoom: () => void;
  setPosition: React.Dispatch<React.SetStateAction<{ x: number; y: number }>>;
  handleWheel: (e: React.WheelEvent | WheelEvent) => void;
  handlePinch: (scaleDelta: number) => void;
}

const MIN_SCALE = 1;
const MAX_SCALE = 5;
const SCALE_STEP = 0.25;

export function useLightbox(): UseLightboxReturn {
  const [isOpen, setIsOpen] = useState<boolean>(false);
  const [images, setImages] = useState<LightboxImage[]>([]);
  const [currentIndex, setCurrentIndex] = useState<number>(0);
  const [scale, setScale] = useState<number>(1);
  const [position, setPosition] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  const resetZoom = useCallback(() => {
    setScale(1);
    setPosition({ x: 0, y: 0 });
  }, []);

  const openLightbox = useCallback(
    (imageList: (string | LightboxImage)[], initialIndex = 0) => {
      const normalized: LightboxImage[] = imageList.map((img, idx) => {
        if (typeof img === 'string') {
          return {
            url: img,
            title: `Design Output #${idx + 1}`,
            alt: `Design image ${idx + 1}`
          };
        }
        return {
          url: img.url,
          title: img.title || `Design Output #${idx + 1}`,
          alt: img.alt || `Design image ${idx + 1}`
        };
      });

      setImages(normalized);
      const validIndex = Math.max(0, Math.min(initialIndex, normalized.length - 1));
      setCurrentIndex(validIndex);
      resetZoom();
      setIsOpen(true);
    },
    [resetZoom]
  );

  const closeLightbox = useCallback(() => {
    setIsOpen(false);
    resetZoom();
  }, [resetZoom]);

  const setIndex = useCallback(
    (index: number) => {
      if (images.length === 0) return;
      const validIndex = Math.max(0, Math.min(index, images.length - 1));
      setCurrentIndex(validIndex);
      resetZoom();
    },
    [images.length, resetZoom]
  );

  const nextImage = useCallback(() => {
    if (images.length === 0) return;
    setCurrentIndex((prev) => (prev + 1) % images.length);
    resetZoom();
  }, [images.length, resetZoom]);

  const prevImage = useCallback(() => {
    if (images.length === 0) return;
    setCurrentIndex((prev) => (prev - 1 + images.length) % images.length);
    resetZoom();
  }, [images.length, resetZoom]);

  const zoomIn = useCallback((step = SCALE_STEP) => {
    setScale((prev) => Math.min(MAX_SCALE, Math.round((prev + step) * 100) / 100));
  }, []);

  const zoomOut = useCallback((step = SCALE_STEP) => {
    setScale((prev) => {
      const nextScale = Math.max(MIN_SCALE, Math.round((prev - step) * 100) / 100);
      if (nextScale === MIN_SCALE) {
        setPosition({ x: 0, y: 0 });
      }
      return nextScale;
    });
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent | WheelEvent) => {
    e.preventDefault();
    if (e.deltaY < 0) {
      setScale((prev) => Math.min(MAX_SCALE, Math.round((prev + 0.15) * 100) / 100));
    } else if (e.deltaY > 0) {
      setScale((prev) => {
        const nextScale = Math.max(MIN_SCALE, Math.round((prev - 0.15) * 100) / 100);
        if (nextScale === MIN_SCALE) {
          setPosition({ x: 0, y: 0 });
        }
        return nextScale;
      });
    }
  }, []);

  const handlePinch = useCallback((scaleDelta: number) => {
    setScale((prev) => {
      const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round((prev + scaleDelta) * 100) / 100));
      if (nextScale === MIN_SCALE) {
        setPosition({ x: 0, y: 0 });
      }
      return nextScale;
    });
  }, []);

  const currentImage = images[currentIndex] || null;

  return {
    isOpen,
    images,
    currentIndex,
    currentImage,
    scale,
    position,
    openLightbox,
    closeLightbox,
    nextImage,
    prevImage,
    setIndex,
    zoomIn,
    zoomOut,
    resetZoom,
    setPosition,
    handleWheel,
    handlePinch
  };
}
