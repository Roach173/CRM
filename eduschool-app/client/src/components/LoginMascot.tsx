import { useEffect, useRef, useState } from "react";

interface LoginMascotProps {
  passwordFocused: boolean;
  emailFocused: boolean;
  hasError: boolean;
}

// Same body/head geometry as the app Logo (Logo.tsx) — 3 candles of ascending
// height, brought to life for the empty left panel on the general /login page.
const CANDLES = [
  { bodyX: 111, bodyY: 250, bodyH: 110, headCx: 146, headCy: 192 },
  { bodyX: 221, bodyY: 190, bodyH: 170, headCx: 256, headCy: 132 },
  { bodyX: 331, bodyY: 130, bodyH: 230, headCx: 366, headCy: 72 },
] as const;

const GROUND_Y = 360;
const BODY_W = 70;
const BODY_COLOR = "#151515";
const HEAD_R = 32;
const HEAD_COLOR = "#E4A034";
const EYE_SPACING = 11;
const EYE_R = 4.5;
const MAX_PUPIL_OFFSET = 4;
const REACT_RADIUS = 240;

const MAX_HEAD_ROTATE_DEG = 16;
const HEAD_ROT_REACT_RADIUS = 320;
const BODY_LEAN_RATIO = 0.16; // body follows the head's rotation, but much softer — head leads, body barely moves

// Distinct "shy" turn-away angles per candle on password focus — varied so
// the three don't all snap to the same pose.
const SHY_ANGLES = [-22, 26, -18] as const;
// On email focus: a modest head turn inward (the eyes do most of the "looking at
// each other" work — see LOOK_EYE_DIRS) plus a real nod, which must be a vertical
// bob, not a rotation wobble — rotating side to side reads as "shaking head no".
const LOOK_AT_ANGLES = [9, 0, -9] as const;
const LOOK_EYE_DIRS = [
  { x: 110, y: -60 }, // outer-left candle looks toward the middle one
  { x: 0, y: 55 }, // middle candle looks down, toward the form being filled
  { x: -110, y: 60 }, // outer-right candle looks toward the middle one
] as const;
const NOD_AMPLITUDE_PX = 5;
const NOD_SPEED = 0.011; // radians per ms — a brisk, clearly-readable nod
// Looking up/down doesn't just move the pupils — the head itself slides a little
// farther from / closer to the body along the neck, like a real head craning up
// or tucking down. Continuous, cursor-driven — separate from the idle neck-drift wander.
const MAX_NECK_STRETCH_PX = 6;
const NECK_STRETCH_RANGE = 220;
const BLINK_DURATION_MS = 140;
// Login error = "no" — a brief left-right head shake, not a nod (nod already means
// "yes"/approval on email focus). Rotation, not translation, is correct here.
const ERROR_SHAKE_MS = 800;

export function LoginMascot({ passwordFocused, emailFocused, hasError }: LoginMascotProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const eyeGroupRefs = useRef<(SVGGElement | null)[]>([]);
  const headGroupRefs = useRef<(SVGGElement | null)[]>([]);
  const leanGroupRefs = useRef<(SVGGElement | null)[]>([]);

  const pointer = useRef({ x: 0, y: 0 });
  const passwordFocusedRef = useRef(passwordFocused);
  const emailFocusedRef = useRef(emailFocused);
  const eyeOffsets = useRef(CANDLES.map(() => ({ x: 0, y: 0 })));
  const headAngles = useRef(CANDLES.map(() => 0));
  const leanAngles = useRef(CANDLES.map(() => 0));
  const neckOffsets = useRef(CANDLES.map(() => 0));

  const [blinking, setBlinking] = useState<boolean[]>(() => CANDLES.map(() => false));
  const [sadPulse, setSadPulse] = useState(false);
  const prevHasError = useRef(false);

  useEffect(() => {
    passwordFocusedRef.current = passwordFocused;
  }, [passwordFocused]);

  useEffect(() => {
    emailFocusedRef.current = emailFocused;
  }, [emailFocused]);

  // A fresh error (false -> true) triggers one brief head shake; a persisting
  // or repeated-identical error doesn't re-trigger it every render.
  useEffect(() => {
    if (hasError && !prevHasError.current) {
      setSadPulse(true);
      const t = setTimeout(() => setSadPulse(false), ERROR_SHAKE_MS);
      prevHasError.current = true;
      return () => clearTimeout(t);
    }
    prevHasError.current = hasError;
  }, [hasError]);

  // Continuous pointer-tracking + shy-pose animation loop. Runs once on mount;
  // reads passwordFocusedRef each frame instead of restarting on every focus toggle.
  useEffect(() => {
    if (!window.matchMedia("(min-width: 1024px)").matches) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const handleMove = (e: MouseEvent) => {
      pointer.current.x = e.clientX;
      pointer.current.y = e.clientY;
    };
    window.addEventListener("mousemove", handleMove, { passive: true });

    let raf = requestAnimationFrame(function tick(now) {
      const svg = svgRef.current;
      if (svg) {
        const rect = svg.getBoundingClientRect();
        const scaleX = rect.width / 512;
        const scaleY = rect.height / 512;
        const focused = passwordFocusedRef.current;
        const greeting = !focused && emailFocusedRef.current;

        CANDLES.forEach((candle, i) => {
          const headScreenX = rect.left + candle.headCx * scaleX;
          const headScreenY = rect.top + candle.headCy * scaleY;
          const dx = pointer.current.x - headScreenX;
          const dy = pointer.current.y - headScreenY;
          const dist = Math.hypot(dx, dy) || 1;

          let eyeTarget: { x: number; y: number };
          if (focused) {
            eyeTarget = { x: 0, y: 0 };
          } else if (greeting) {
            const dir = LOOK_EYE_DIRS[i];
            const dirDist = Math.hypot(dir.x, dir.y) || 1;
            eyeTarget = { x: (dir.x / dirDist) * MAX_PUPIL_OFFSET, y: (dir.y / dirDist) * MAX_PUPIL_OFFSET };
          } else {
            eyeTarget = {
              x: (dx / dist) * MAX_PUPIL_OFFSET * Math.min(dist / REACT_RADIUS, 1),
              y: (dy / dist) * MAX_PUPIL_OFFSET * Math.min(dist / REACT_RADIUS, 1),
            };
          }
          const eyeOffset = eyeOffsets.current[i];
          eyeOffset.x += (eyeTarget.x - eyeOffset.x) * 0.22;
          eyeOffset.y += (eyeTarget.y - eyeOffset.y) * 0.22;
          eyeGroupRefs.current[i]?.setAttribute("transform", `translate(${eyeOffset.x.toFixed(2)} ${eyeOffset.y.toFixed(2)})`);

          let headTarget: number;
          if (focused) {
            headTarget = SHY_ANGLES[i];
          } else if (greeting) {
            headTarget = LOOK_AT_ANGLES[i];
          } else {
            headTarget = Math.max(-MAX_HEAD_ROTATE_DEG, Math.min(MAX_HEAD_ROTATE_DEG, (dx / HEAD_ROT_REACT_RADIUS) * MAX_HEAD_ROTATE_DEG));
          }
          headAngles.current[i] += (headTarget - headAngles.current[i]) * 0.14;
          const headPivotY = candle.headCy + HEAD_R;
          // Nod ("yes") is a vertical bob applied in screen space, on top of any rotation —
          // never folded into the rotation angle itself, or it would read as head-shaking "no".
          const nodY = greeting ? Math.sin(now * NOD_SPEED + i * 0.5) * NOD_AMPLITUDE_PX : 0;
          // Looking up cranes the neck (head slides away from the body); looking down
          // tucks the chin (head slides closer). Only during plain cursor tracking —
          // the focused/greeting poses have their own fixed vertical language already.
          const neckTarget =
            focused || greeting ? 0 : Math.max(-1, Math.min(1, dy / NECK_STRETCH_RANGE)) * MAX_NECK_STRETCH_PX;
          neckOffsets.current[i] += (neckTarget - neckOffsets.current[i]) * 0.1;
          const totalY = nodY + neckOffsets.current[i];
          headGroupRefs.current[i]?.setAttribute(
            "transform",
            `translate(0 ${totalY.toFixed(2)}) rotate(${headAngles.current[i].toFixed(2)} ${candle.headCx} ${headPivotY})`
          );

          const leanTarget = headTarget * BODY_LEAN_RATIO;
          leanAngles.current[i] += (leanTarget - leanAngles.current[i]) * 0.08;
          leanGroupRefs.current[i]?.setAttribute(
            "transform",
            `rotate(${leanAngles.current[i].toFixed(2)} ${candle.headCx} ${GROUND_Y})`
          );
        });
      }
      raf = requestAnimationFrame(tick);
    });

    return () => {
      window.removeEventListener("mousemove", handleMove);
      cancelAnimationFrame(raf);
    };
  }, []);

  // Idle blinking — small independent timers, paused while the password-focus pose is active.
  useEffect(() => {
    if (!window.matchMedia("(min-width: 1024px)").matches) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const timeouts: ReturnType<typeof setTimeout>[] = [];
    const scheduleBlink = (i: number) => {
      const delay = 2500 + Math.random() * 3500;
      timeouts[i] = setTimeout(() => {
        if (!passwordFocusedRef.current) {
          setBlinking((prev) => prev.map((v, idx) => (idx === i ? true : v)));
          setTimeout(() => {
            setBlinking((prev) => prev.map((v, idx) => (idx === i ? false : v)));
          }, BLINK_DURATION_MS);
        }
        scheduleBlink(i);
      }, delay);
    };
    CANDLES.forEach((_, i) => scheduleBlink(i));

    return () => timeouts.forEach(clearTimeout);
  }, []);

  return (
    // Extra viewBox padding (vs. the tight logo bbox) so head rotation/bob/neck-drift
    // never clip against the SVG's own edge.
    <svg ref={svgRef} viewBox="60 -30 400 440" className="w-full max-w-[220px] xl:max-w-[260px] mx-auto" aria-hidden="true">
      <style>{`
        @keyframes headBob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-2.5px); } }
        @keyframes neckDrift {
          0%, 100% { transform: translate(0, 0); }
          25% { transform: translate(3px, -5px); }
          50% { transform: translate(-2px, 1.5px); }
          75% { transform: translate(-3.5px, -2.5px); }
        }
        .head-bob-0 { animation: headBob 3.4s ease-in-out infinite; }
        .head-bob-1 { animation: headBob 3.8s ease-in-out infinite 0.25s; }
        .head-bob-2 { animation: headBob 4.1s ease-in-out infinite 0.5s; }
        .neck-drift-0 { animation: neckDrift 5.2s ease-in-out infinite; }
        .neck-drift-1 { animation: neckDrift 5.8s ease-in-out infinite 0.4s; }
        .neck-drift-2 { animation: neckDrift 6.3s ease-in-out infinite 0.8s; }
        @keyframes errorShake {
          0%, 100% { transform: rotate(0deg); }
          20% { transform: rotate(-8deg); }
          40% { transform: rotate(7deg); }
          60% { transform: rotate(-5deg); }
          80% { transform: rotate(3deg); }
        }
        .error-shake-active { animation: errorShake 0.8s ease-in-out 1; transform-box: fill-box; transform-origin: 50% 50%; }
        @keyframes candleEnter {
          0% { opacity: 0; transform: translateY(14px) scale(0.9); }
          100% { opacity: 1; transform: translateY(0) scale(1); }
        }
        .candle-enter-0 { animation: candleEnter 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) 0.05s backwards; }
        .candle-enter-1 { animation: candleEnter 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) 0.15s backwards; }
        .candle-enter-2 { animation: candleEnter 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) 0.25s backwards; }
        @media (prefers-reduced-motion: reduce) {
          [class*="head-bob-"], [class*="neck-drift-"], [class*="candle-enter-"], .error-shake-active { animation: none; }
        }
      `}</style>
      {CANDLES.map((candle, i) => {
        const eyesClosed = passwordFocused || blinking[i];
        const leftEyeCx = candle.headCx - EYE_SPACING;
        const rightEyeCx = candle.headCx + EYE_SPACING;
        const eyeCy = candle.headCy - 2;
        return (
          <g key={i} className={`candle-enter-${i}`}>
            <g
              ref={(el) => {
                leanGroupRefs.current[i] = el;
              }}
            >
              <rect x={candle.bodyX} y={candle.bodyY} width={BODY_W} height={candle.bodyH} rx={20} fill={BODY_COLOR} />
              {/* The gap between body and head is the (invisible) neck — drifts a little for a less robotic feel. */}
              <g className={`neck-drift-${i}`}>
                <g className={sadPulse ? "error-shake-active" : undefined}>
                  <g
                    ref={(el) => {
                      headGroupRefs.current[i] = el;
                    }}
                  >
                    <g className={`head-bob-${i}`}>
                      <circle cx={candle.headCx} cy={candle.headCy} r={HEAD_R} fill={HEAD_COLOR} />

                      {eyesClosed ? (
                        <>
                          <path
                            d={`M ${leftEyeCx - 5} ${eyeCy} Q ${leftEyeCx} ${eyeCy + 4} ${leftEyeCx + 5} ${eyeCy}`}
                            stroke={BODY_COLOR}
                            strokeWidth={2.5}
                            strokeLinecap="round"
                            fill="none"
                          />
                          <path
                            d={`M ${rightEyeCx - 5} ${eyeCy} Q ${rightEyeCx} ${eyeCy + 4} ${rightEyeCx + 5} ${eyeCy}`}
                            stroke={BODY_COLOR}
                            strokeWidth={2.5}
                            strokeLinecap="round"
                            fill="none"
                          />
                        </>
                      ) : (
                        <g
                          ref={(el) => {
                            eyeGroupRefs.current[i] = el;
                          }}
                        >
                          <circle cx={leftEyeCx} cy={eyeCy} r={EYE_R} fill={BODY_COLOR} />
                          <circle cx={rightEyeCx} cy={eyeCy} r={EYE_R} fill={BODY_COLOR} />
                        </g>
                      )}

                      {hasError ? (
                        <path
                          d={`M ${candle.headCx - 6} ${candle.headCy + 13} Q ${candle.headCx} ${candle.headCy + 9} ${candle.headCx + 6} ${candle.headCy + 13}`}
                          stroke={BODY_COLOR}
                          strokeWidth={2.2}
                          strokeLinecap="round"
                          fill="none"
                          opacity={0.85}
                        />
                      ) : (
                        <path
                          d={`M ${candle.headCx - 6} ${candle.headCy + 12} Q ${candle.headCx} ${candle.headCy + 15} ${candle.headCx + 6} ${candle.headCy + 12}`}
                          stroke={BODY_COLOR}
                          strokeWidth={2.2}
                          strokeLinecap="round"
                          fill="none"
                          opacity={0.85}
                        />
                      )}
                    </g>
                  </g>
                </g>
              </g>
            </g>
          </g>
        );
      })}
    </svg>
  );
}
