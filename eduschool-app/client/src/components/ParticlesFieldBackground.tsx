import { useEffect, useRef, useState } from "react";

export type ParticlesFieldBackgroundProps = {
  particleCount?: number;
  particleSize?: number;
  speed?: number;
  mouseStrength?: number;
  opacity?: number;
  glowStrength?: number;
  className?: string;
  colors?: string[];
  theme?: "dark" | "light";
  variant?: "hero" | "section-soft";
};

interface Particle {
  shellRadius: number;
  shellAngle: number;
  shellSpeed: number;
  wavePhase: number;
  depth: number;
  baseLength: number;
  baseThickness: number;
  baseAlpha: number;
  color: string;
  layerOffsetX: number;
  layerOffsetY: number;
  pulseSpeed: number;
}

interface AmbientParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  size: number;
  alpha: number;
  color: string;
  depth: number;
  phase: number;
  driftSpeed: number;
}

const DEFAULT_DARK_COLORS = [
  "rgba(52, 211, 153, 1)",  // emerald
  "rgba(45, 212, 191, 1)",  // teal
  "rgba(16, 185, 129, 1)",  // emerald deep
  "rgba(110, 231, 183, 1)"  // mint
];

const DEFAULT_LIGHT_COLORS = [
  "rgba(16, 185, 129, 0.85)", // emerald deep
  "rgba(13, 148, 136, 0.85)", // teal deep
  "rgba(4, 120, 87, 0.85)",   // green deep
  "rgba(20, 184, 166, 0.85)"  // teal
];

export function ParticlesFieldBackground({
  particleCount,
  particleSize = 1.15,
  speed,
  mouseStrength,
  opacity,
  glowStrength,
  className = "",
  colors,
  theme = "dark",
  variant = "hero",
}: ParticlesFieldBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  const [isMobile, setIsMobile] = useState(false);
  const selectedColors = colors ?? (theme === "light" ? DEFAULT_LIGHT_COLORS : DEFAULT_DARK_COLORS);
  
  const isHero = variant === "hero";
  
  // Adaptive configuration parameters based on variant
  const finalParticleCount = particleCount ?? (isHero ? (isMobile ? 120 : 320) : (isMobile ? 40 : 120));
  const finalSpeed = speed ?? (isHero ? 0.55 : 0.28);
  const finalMouseStrength = mouseStrength ?? (isHero ? 0.18 : 0.08);
  const finalOpacity = opacity ?? (isHero ? 0.55 : 0.24);
  const finalGlowStrength = glowStrength ?? (isHero ? 0.65 : 0.12);

  // Track pointer targets and spring physics coordinates
  const targetMouseRef = useRef({ x: 0, y: 0, active: false });
  const focusRef = useRef({
    x: 0,
    y: 0,
    targetX: 0,
    targetY: 0,
    vx: 0,
    vy: 0,
    influence: isHero ? 0.35 : 0.15,
  });

  // Track responsive mobile viewport size
  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth < 768);
    };
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const prefersReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;

    let animationFrameId: number;
    let particles: Particle[] = [];
    let ambientParticles: AmbientParticle[] = [];
    let width = 0;
    let height = 0;

    // Reset dimensions and distribute shell elements
    const resizeCanvas = () => {
      const rect = container.getBoundingClientRect();
      width = rect.width;
      height = rect.height;

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      
      ctx.scale(dpr, dpr);

      // Default focal resting position is exactly in the center of the screen
      const restingX = width * 0.5;
      const restingY = height * 0.5;

      if (focusRef.current.x === 0) {
        focusRef.current.x = restingX;
        focusRef.current.y = restingY;
      }
      focusRef.current.targetX = restingX;
      focusRef.current.targetY = restingY;

      // 1. Initialize Concentric Shell Wave Swarm
      particles = [];
      const maxRadius = Math.max(width, height) * 0.65;
      
      for (let i = 0; i < finalParticleCount; i++) {
        const depth = 0.35 + Math.random() * 0.65; // pseudo 3D perspective
        
        // Massive scale distribution
        const radius = maxRadius * (0.05 + Math.random() * 0.85);

        // Core weights
        const baseThickness = particleSize * (0.8 + Math.random() * 0.6);
        const baseLength = 5.2 + Math.random() * 2.8;
        const baseAlpha = 0.18 + (depth - 0.35) * 0.52;

        // Micro organic jitter around exact shell coordinate
        const layerOffsetX = (Math.random() * 2 - 1) * 20;
        const layerOffsetY = (Math.random() * 2 - 1) * 12;

        particles.push({
          shellRadius: radius * (isMobile ? 0.75 : 1.0),
          shellAngle: Math.random() * Math.PI * 2,
          shellSpeed: (0.00005 + Math.random() * 0.00015) * (Math.random() < 0.5 ? 1 : -1) * finalSpeed,
          wavePhase: Math.random() * Math.PI * 2,
          depth,
          baseLength,
          baseThickness,
          baseAlpha,
          color: selectedColors[Math.floor(Math.random() * selectedColors.length)],
          layerOffsetX,
          layerOffsetY,
          pulseSpeed: 0.0006 + Math.random() * 0.0012,
        });
      }

      // 2. Initialize Background Drift Layer
      const aCount = isMobile ? (isHero ? 8 : 4) : (isHero ? 20 : 8);
      ambientParticles = [];
      for (let i = 0; i < aCount; i++) {
        const depth = 0.2 + Math.random() * 0.3;
        ambientParticles.push({
          x: Math.random() * width,
          y: Math.random() * height,
          vx: (Math.random() * 2 - 1) * 0.05 * finalSpeed,
          vy: (Math.random() * 2 - 1) * 0.05 * finalSpeed,
          angle: Math.random() * Math.PI * 2,
          size: particleSize * (0.5 + Math.random() * 0.5),
          alpha: 0.06 + Math.random() * 0.08,
          color: selectedColors[Math.floor(Math.random() * selectedColors.length)],
          depth,
          phase: Math.random() * Math.PI * 2,
          driftSpeed: 0.0012 + Math.random() * 0.0022,
        });
      }
    };

    const resizeObserver = new ResizeObserver(() => {
      resizeCanvas();
    });
    resizeObserver.observe(container);

    const handlePointerMove = (e: PointerEvent) => {
      if (prefersReducedMotion) return;
      const rect = canvas.getBoundingClientRect();
      targetMouseRef.current.x = e.clientX - rect.left;
      targetMouseRef.current.y = e.clientY - rect.top;
      targetMouseRef.current.active = true;
    };

    const handlePointerLeave = () => {
      targetMouseRef.current.active = false;
    };

    const handlePointerEnter = () => {
      if (prefersReducedMotion) return;
      targetMouseRef.current.active = true;
    };

    const parent = container.parentElement || container;
    parent.addEventListener("pointermove", handlePointerMove, { passive: true });
    parent.addEventListener("pointerleave", handlePointerLeave, { passive: true });
    parent.addEventListener("pointerenter", handlePointerEnter, { passive: true });

    // Main render loop
    const render = () => {
      ctx.clearRect(0, 0, width, height);

      const time = performance.now();
      const focus = focusRef.current;

      // --- SPRING PHYSICAL CENTER FOCUS ANCHOR CALCULATIONS ---
      if (!prefersReducedMotion && targetMouseRef.current.active) {
        focus.targetX = targetMouseRef.current.x;
        focus.targetY = targetMouseRef.current.y;
        focus.influence += (1.0 - focus.influence) * 0.05;
      } else {
        // Glide anchor slowly back to rested absolute center position
        const restingX = width * 0.5;
        const restingY = height * 0.5;
        focus.targetX += (restingX - focus.targetX) * 0.035;
        focus.targetY += (restingY - focus.targetY) * 0.035;
        focus.influence += ((isHero ? 0.35 : 0.15) - focus.influence) * 0.03;
      }

      if (!prefersReducedMotion) {
        // Sluggish, massive Spring following (stiffness: 0.0009, damping: 0.945)
        // For secondary sections, stiffness is even lower (0.0006) for calmer motion
        const stiffness = isHero ? 0.0009 : 0.0006;
        const damping = isHero ? 0.945 : 0.96;
        focus.vx += (focus.targetX - focus.x) * stiffness;
        focus.vy += (focus.targetY - focus.y) * stiffness;
        focus.vx *= damping;
        focus.vy *= damping;
        focus.x += focus.vx;
        focus.y += focus.vy;
      } else {
        focus.x = width * 0.5;
        focus.y = height * 0.5;
        focus.vx = 0;
        focus.vy = 0;
      }

      // Drag stretch layout calculation along focus velocity vector
      const velocity = Math.sqrt(focus.vx * focus.vx + focus.vy * focus.vy);
      const stretch = Math.max(0, Math.min(isHero ? 0.22 : 0.10, velocity * (isHero ? 0.018 : 0.01)));
      const vxNorm = focus.vx / (velocity || 1);
      const vyNorm = focus.vy / (velocity || 1);

      // Base time parameter for wave flows
      const timeWave = time * (isHero ? 0.00045 : 0.00025);

      // --- 1. RENDER BACKGROUND AMBIENT CAPSULES ---
      for (let i = 0; i < ambientParticles.length; i++) {
        const ap = ambientParticles[i];
        
        ap.phase += ap.driftSpeed * (prefersReducedMotion ? 0.01 : 0.8);
        const driftX = Math.sin(ap.phase) * 0.03;
        const driftY = Math.cos(ap.phase) * 0.03;

        const currentSpeed = prefersReducedMotion ? 0.01 : 0.8;
        ap.x += (ap.vx + driftX) * currentSpeed;
        ap.y += (ap.vy + driftY) * currentSpeed;

        if (ap.x < -30) ap.x = width + 30;
        if (ap.x > width + 30) ap.x = -30;
        if (ap.y < -30) ap.y = height + 30;
        if (ap.y > height + 30) ap.y = -30;

        const dx = Math.cos(ap.angle) * ap.size;
        const dy = Math.sin(ap.angle) * ap.size;

        ctx.save();
        ctx.lineCap = "round";
        ctx.lineWidth = ap.size;
        ctx.strokeStyle = ap.color;
        ctx.globalAlpha = ap.alpha * finalOpacity;

        ctx.beginPath();
        ctx.moveTo(ap.x - dx, ap.y - dy);
        ctx.lineTo(ap.x + dx, ap.y + dy);
        ctx.stroke();
        ctx.restore();
      }

      // --- 2. RENDER ACTIVE SPHERICAL WAVE CAPSULE FIELD ---
      const maxRadius = Math.max(width, height) * 0.65;

      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];

        // Concentric breathing shells wave
        const wave = prefersReducedMotion 
          ? 1.0 
          : Math.sin(timeWave * 3.0 - p.shellRadius * 0.015 + p.wavePhase);
        const breathing = 1 + wave * (isHero ? 0.055 : 0.035);

        // Angle around central focal sphere
        const activeOrbitSpeed = prefersReducedMotion ? 0.00001 : p.shellSpeed;
        const angle = p.shellAngle + (time * activeOrbitSpeed) + Math.sin(time * 0.00025 + p.wavePhase) * 0.10;

        // Propagating radial wave factor
        let radius = p.shellRadius * breathing;
        const normalizedDistance = Math.min(1, Math.max(0, radius / maxRadius));
        
        // Localized ripple wave
        const radialWave = prefersReducedMotion
          ? 0.5
          : (0.5 + 0.5 * Math.sin(time * (isHero ? 0.0012 : 0.0008) - normalizedDistance * 5.5 + p.wavePhase));
        
        radius += (radialWave - 0.5) * (isHero ? 10 : 5) * p.depth;

        // Perspective depth calculations
        const perspective = 0.55 + p.depth * 0.75;

        // Compute 3D coordinate layers
        let x = focus.x + Math.cos(angle) * radius * perspective + p.layerOffsetX;
        let y = focus.y + Math.sin(angle) * radius * 0.62 * perspective + p.layerOffsetY;

        // Swarm velocity stretching
        if (stretch > 0.01) {
          x += vxNorm * stretch * p.shellRadius * 0.12 * p.depth;
          y += vyNorm * stretch * p.shellRadius * 0.62 * 0.12 * p.depth;
        }

        // Pseudo-3D Parallax offset from screen center
        if (!prefersReducedMotion) {
          const pxOffset = (focus.x - width / 2) * (isHero ? 0.014 : 0.008) * p.depth;
          const pyOffset = (focus.y - height / 2) * (isHero ? 0.014 : 0.008) * p.depth;
          x += pxOffset;
          y += pyOffset;
        }

        // --- DISTANCE-BASED CAPSULE GEOMETRY SCALING ---
        const distToCenter = Math.hypot(x - focus.x, y - focus.y);
        const r = Math.max(0, Math.min(1, distToCenter / maxRadius));

        // Pulsation of particle shape
        const shapePulse = prefersReducedMotion 
          ? 0.5 
          : (0.5 + 0.5 * Math.sin(time * p.pulseSpeed + p.wavePhase));

        // Capsule length
        let currentLength = (1.1 * (1 - r) + 6.2 * r) * (0.75 + shapePulse * 0.25) * (0.75 + p.depth * 0.45);
        // Capsule thickness
        let currentThickness = (3.0 * (1 - r) + 1.6 * r) * (0.9 + shapePulse * 0.1) * (0.8 + p.depth * 0.35);

        // Apply radial wave modifiers
        currentLength *= 0.75 + radialWave * 0.25;
        
        // Dynamic radial brightness wave
        const radialBrightnessWave = 0.5 + 0.5 * Math.sin(time * (isHero ? 0.0012 : 0.0008) - r * 6.2 + p.wavePhase);
        let currentAlpha = p.baseAlpha * (0.65 + radialBrightnessWave * 0.35) * (0.35 + p.depth * 0.75);

        // Clamping density near boundaries & center
        if (r < 0.15) {
          currentAlpha *= 0.75;
        }
        currentAlpha *= (1.0 - r * 0.45);

        // Capsule geometry bounds safety
        currentLength = Math.max(1.0, Math.min(7.0, currentLength));
        currentThickness = Math.max(1.8, Math.min(3.4, currentThickness));

        // --- CAPSULE ALIGNMENT TOWARDS CENTER FOCUS ANCHOR ---
        const toCenterX = focus.x - x;
        const toCenterY = focus.y - y;
        const dist = Math.hypot(toCenterX, toCenterY) || 1;

        const cx = toCenterX / dist;
        const cy = toCenterY / dist;

        const tx = -cy;
        const ty = cx;

        // Blending orientation (80% center pointed, 20% tangent orbiting)
        const mx = cx * 0.8 + tx * 0.2;
        const my = cy * 0.8 + ty * 0.2;

        let currentAngle = Math.atan2(my, mx);
        currentAngle += Math.sin(time * 0.0008 + p.wavePhase) * 0.15; // micro oscillation

        const dx = Math.cos(currentAngle) * (currentLength / 2);
        const dy = Math.sin(currentAngle) * (currentLength / 2);

        ctx.save();
        ctx.lineCap = "round";

        // Layer A: Soft outer Glow
        if (finalGlowStrength > 0) {
          ctx.lineWidth = currentThickness * 2.2;
          ctx.strokeStyle = p.color;
          ctx.globalAlpha = currentAlpha * finalOpacity * 0.12 * finalGlowStrength;
          
          ctx.beginPath();
          ctx.moveTo(x - dx, y - dy);
          ctx.lineTo(x + dx, y + dy);
          ctx.stroke();
        }

        // Layer B: Solid capsule core
        ctx.lineWidth = currentThickness;
        ctx.strokeStyle = p.color;
        ctx.globalAlpha = currentAlpha * finalOpacity;

        ctx.beginPath();
        ctx.moveTo(x - dx, y - dy);
        ctx.lineTo(x + dx, y + dy);
        ctx.stroke();

        ctx.restore();
      }

      animationFrameId = requestAnimationFrame(render);
    };

    animationFrameId = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(animationFrameId);
      resizeObserver.disconnect();
      parent.removeEventListener("pointermove", handlePointerMove);
      parent.removeEventListener("pointerleave", handlePointerLeave);
      parent.removeEventListener("pointerenter", handlePointerEnter);
    };
  }, [
    finalParticleCount,
    particleSize,
    finalSpeed,
    finalMouseStrength,
    finalOpacity,
    finalGlowStrength,
    selectedColors,
    isMobile,
    isHero
  ]);

  return (
    <div
      ref={containerRef}
      className={`absolute inset-0 select-none pointer-events-none overflow-hidden ${className}`}
      style={{ zIndex: 0 }}
    >
      <canvas
        ref={canvasRef}
        className="block pointer-events-none w-full h-full"
        style={{ mixBlendMode: theme === "dark" ? "screen" : "normal" }}
      />
    </div>
  );
}
