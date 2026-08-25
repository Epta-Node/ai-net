import { useEffect, useRef } from 'react';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
}

export function useParticles() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const prefersReducedMotion = useRef(
    typeof window !== 'undefined' 
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches 
      : false
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || prefersReducedMotion.current) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let particles: Particle[] = [];
    const MAX_PARTICLES = 80;
    const CONNECTION_DISTANCE = 150;
    const PARTICLE_COLOR = 'rgba(56, 189, 248, 0.15)'; // #38BDF8 with low opacity
    const LINE_COLOR_BASE = '56, 189, 248';

    let animationFrameId: number;

    const resize = () => {
      // Setup pixel ratio for sharp rendering
      const dpr = window.devicePixelRatio || 1;
      // Get logical size
      const rect = canvas.getBoundingClientRect();
      
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.scale(dpr, dpr);
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      
      initParticles(rect.width, rect.height);
    };

    const initParticles = (width: number, height: number) => {
      particles = [];
      for (let i = 0; i < MAX_PARTICLES; i++) {
        particles.push({
          x: Math.random() * width,
          y: Math.random() * height,
          vx: (Math.random() - 0.5) * 1.5,
          vy: (Math.random() - 0.5) * 1.5,
          radius: Math.random() * 2 + 1,
        });
      }
    };

    const animate = () => {
      // Width and height are CSS sizes
      const width = canvas.getBoundingClientRect().width;
      const height = canvas.getBoundingClientRect().height;

      ctx.clearRect(0, 0, width, height);

      // Update and draw particles
      particles.forEach((p, index) => {
        p.x += p.vx;
        p.y += p.vy;

        // Bounce off walls
        if (p.x < 0 || p.x > width) p.vx *= -1;
        if (p.y < 0 || p.y > height) p.vy *= -1;

        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        ctx.fillStyle = PARTICLE_COLOR;
        ctx.fill();

        // Connect particles
        for (let j = index + 1; j < particles.length; j++) {
          const p2 = particles[j];
          const dx = p.x - p2.x;
          const dy = p.y - p2.y;
          const distance = Math.sqrt(dx * dx + dy * dy);

          if (distance < CONNECTION_DISTANCE) {
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(p2.x, p2.y);
            // Opacity fades with distance
            const opacity = 1 - distance / CONNECTION_DISTANCE;
            ctx.strokeStyle = `rgba(${LINE_COLOR_BASE}, ${opacity * 0.2})`;
            ctx.stroke();
          }
        }
      });

      animationFrameId = requestAnimationFrame(animate);
    };

    // Use ResizeObserver for more robust resizing based on parent container
    const resizeObserver = new ResizeObserver(() => {
        resize();
    });
    
    // observe the parent of the canvas, or the canvas itself if width/height are set via css
    resizeObserver.observe(canvas.parentElement || canvas);

    resize();
    animate();

    return () => {
      cancelAnimationFrame(animationFrameId);
      resizeObserver.disconnect();
    };
  }, []);

  return { canvasRef, prefersReducedMotion: prefersReducedMotion.current };
}
