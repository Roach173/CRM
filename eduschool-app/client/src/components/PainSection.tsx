import { useEffect, useRef, useState, type CSSProperties } from 'react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { AlertTriangle, CheckCircle2, RadioTower, ShieldCheck } from 'lucide-react';

gsap.registerPlugin(ScrollTrigger);

type GrowthCard = {
  problem: string;
  solution: string;
  signal: string;
  metric: string;
};

type CardState = {
  solved: boolean;
  switching: boolean;
};

const growthCards: GrowthCard[] = [
  {
    problem: 'Заявки теряются в мессенджерах',
    solution: 'Все обращения автоматически попадают в CRM',
    signal: 'lead lost',
    metric: '0 потерянных лидов',
  },
  {
    problem: 'Администраторы забывают дожимать клиентов',
    solution: 'CRM сама ставит задачи и напоминает о касаниях',
    signal: 'no follow-up',
    metric: 'каждый лид в работе',
  },
  {
    problem: 'Долги всплывают слишком поздно',
    solution: 'Система показывает задолженность в реальном времени',
    signal: 'late debt',
    metric: 'финансы онлайн',
  },
  {
    problem: 'Расписание конфликтует',
    solution: 'Конфликты предотвращаются автоматически',
    signal: 'slot conflict',
    metric: 'нет накладок',
  },
  {
    problem: 'Учёт ведётся вручную',
    solution: 'Посещения, оплаты и прогресс собираются в одном контуре',
    signal: 'manual work',
    metric: 'единый учёт',
  },
  {
    problem: 'Руководитель видит цифры постфактум',
    solution: 'Дашборды показывают картину школы прямо сейчас',
    signal: 'late data',
    metric: 'live dashboard',
  },
  {
    problem: 'Школа зависит от памяти сотрудников',
    solution: 'Процессы закреплены в системе, а не в головах',
    signal: 'human memory',
    metric: 'процесс стабилен',
  },
  {
    problem: 'Окупаемость рекламы неизвестна',
    solution: 'ROMI, источники и заявки связаны в прозрачную воронку',
    signal: 'blind CAC',
    metric: 'маркетинг под контролем',
  },
];

const copyPhases = [
  'Пока школа растёт, хаос растёт быстрее',
  'Каждый процесс работает по правилам, а не по памяти сотрудников',
  'Школа работает как единая система',
];

const initialCardStyle = {
  '--focus': 0,
  '--solved': 0,
} as CSSProperties;

const createCardState = (): CardState[] => growthCards.map(() => ({ solved: false, switching: false }));

export function PainSection() {
  const sectionRef = useRef<HTMLElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const cardsRef = useRef<HTMLElement[]>([]);
  const phaseRef = useRef(0);
  const progressRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const cardStatesRef = useRef<CardState[]>(createCardState());
  const pendingSolvedRef = useRef<boolean[]>(growthCards.map(() => false));
  const switchTimersRef = useRef<number[][]>(growthCards.map(() => []));
  const [phase, setPhase] = useState(0);
  const [cardStates, setCardStates] = useState<CardState[]>(createCardState);

  useEffect(() => {
    cardStatesRef.current = cardStates;
  }, [cardStates]);

  useEffect(() => {
    const section = sectionRef.current;
    const stage = stageRef.current;
    const track = trackRef.current;
    const sticky = section?.querySelector<HTMLElement>('.growth-pain-sticky');
    const cards = cardsRef.current.filter(Boolean);

    if (!section || !stage || !track || !sticky || !cards.length) return undefined;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const clamp = gsap.utils.clamp(0, 1);

    const updateCardState = (index: number, patch: Partial<CardState>) => {
      setCardStates((current) => {
        const next = current.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item));
        cardStatesRef.current = next;
        return next;
      });
    };

    const clearSwitchTimers = (index: number) => {
      switchTimersRef.current[index].forEach((timerId) => window.clearTimeout(timerId));
      switchTimersRef.current[index] = [];
    };

    const triggerCardSwitch = (index: number, solved: boolean) => {
      const current = cardStatesRef.current[index];
      if (!current || (pendingSolvedRef.current[index] === solved && current.solved === solved)) return;

      pendingSolvedRef.current[index] = solved;
      clearSwitchTimers(index);
      updateCardState(index, { switching: true });

      const flipTimer = window.setTimeout(() => {
        updateCardState(index, { solved });
      }, 86);

      const settleTimer = window.setTimeout(() => {
        updateCardState(index, { switching: false });
      }, 230);

      switchTimersRef.current[index] = [flipTimer, settleTimer];
    };

    const paintCards = () => {
      const stageRect = stage.getBoundingClientRect();
      const center = stageRect.left + stageRect.width * 0.5;
      const focusDistance = Math.max(260, stageRect.width * 0.4);

      cards.forEach((card, index) => {
        const rect = card.getBoundingClientRect();
        const cardCenter = rect.left + rect.width * 0.5;
        const distance = Math.abs(center - cardCenter);
        const focus = clamp(1 - distance / focusDistance);
        const forceSolved = progressRef.current > 0.86 && index >= cards.length - 2;
        const targetSolved = cardCenter <= center + 24 || forceSolved;
        const currentSolved = cardStatesRef.current[index]?.solved ?? false;
        const solved = currentSolved ? 1 : 0;
        const scale = 0.9 + focus * 0.25;
        const lift = -20 * focus;
        const blur = (1 - focus) * 1.65;
        const brightness = 0.76 + focus * 0.34 + solved * 0.08;

        if (targetSolved !== pendingSolvedRef.current[index]) {
          triggerCardSwitch(index, targetSolved);
        }

        card.style.setProperty('--focus', focus.toFixed(3));
        card.style.setProperty('--solved', solved.toFixed(3));
        card.style.opacity = String(0.48 + focus * 0.52);
        card.style.filter = `blur(${blur.toFixed(2)}px) brightness(${brightness.toFixed(2)})`;
        card.style.transform = `translate3d(0, ${lift.toFixed(2)}px, 0) scale(${scale.toFixed(3)})`;
        card.style.zIndex = String(10 + Math.round(focus * 90));
      });
    };

    const schedulePaint = () => {
      if (rafRef.current !== null) return;

      rafRef.current = window.requestAnimationFrame(() => {
        rafRef.current = null;
        paintCards();
      });
    };

    if (reducedMotion) {
      gsap.set(track, { x: 0 });
      setCardStates(growthCards.map(() => ({ solved: true, switching: false })));
      cards.forEach((card) => {
        card.style.setProperty('--focus', '1');
        card.style.setProperty('--solved', '1');
        card.style.opacity = '1';
        card.style.filter = 'none';
      });
      setPhase(2);
      return undefined;
    }

    const updatePhase = (progress: number) => {
      const nextPhase = progress < 0.34 ? 0 : progress < 0.72 ? 1 : 2;

      if (nextPhase !== phaseRef.current) {
        phaseRef.current = nextPhase;
        setPhase(nextPhase);
      }
    };

    const ctx = gsap.context(() => {
      gsap.set(track, {
        x: () => stage.clientWidth * 0.76,
        force3D: true,
      });

      gsap.to(track, {
        x: () => {
          const endAnchor = window.innerWidth < 640 ? 0.94 : 0.62;
          return -(track.scrollWidth - stage.clientWidth * endAnchor);
        },
        ease: 'none',
        force3D: true,
        onUpdate: schedulePaint,
        scrollTrigger: {
          trigger: section,
          start: 'top top',
          end: 'bottom bottom',
          pin: sticky,
          pinSpacing: false,
          anticipatePin: 1,
          scrub: 0.82,
          invalidateOnRefresh: true,
          onRefresh: schedulePaint,
          onUpdate: (self) => {
            progressRef.current = self.progress;
            updatePhase(self.progress);
            schedulePaint();
          },
        },
      });
    }, section);

    const lenis = (window as unknown as { lenis?: { on: (event: string, callback: () => void) => void; off: (event: string, callback: () => void) => void } }).lenis;
    lenis?.on('scroll', ScrollTrigger.update);
    window.addEventListener('resize', schedulePaint);
    schedulePaint();

    return () => {
      lenis?.off('scroll', ScrollTrigger.update);
      window.removeEventListener('resize', schedulePaint);
      switchTimersRef.current.forEach((_, index) => clearSwitchTimers(index));
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      ctx.revert();
    };
  }, []);

  return (
    <section className="growth-pain-section relative isolate bg-[#090b0f] text-white" data-snap-section ref={sectionRef}>
      <div className="growth-pain-bg" />
      <div className="growth-pain-sticky">
        <div className="growth-pain-copy">
          <p className="growth-pain-eyebrow">боль роста</p>
          <h2 className="growth-pain-title">Хаос становится порядком</h2>
        </div>

        <div className="growth-pain-stage" ref={stageRef}>
          <div className="growth-pain-horizon" />
          <div className="growth-pain-track" ref={trackRef}>
            {growthCards.map((card, index) => {
              const state = cardStates[index] ?? { solved: false, switching: false };
              const Icon = state.solved ? CheckCircle2 : AlertTriangle;

              return (
                <article
                  className={`growth-problem-card ${state.switching ? 'is-switching' : ''} ${index === growthCards.length - 1 ? 'growth-problem-card-final' : ''}`}
                  key={card.problem}
                  ref={(node) => {
                    if (node) cardsRef.current[index] = node;
                  }}
                  style={initialCardStyle}
                >
                  <div className="growth-card-glow" />
                  <div className="growth-card-grid" />
                  <div className="growth-card-switch-flash" aria-hidden="true" />
                  <div className="growth-card-head">
                    <div className={`growth-card-icon ${state.solved ? 'is-solved' : 'is-problem'}`} aria-hidden="true">
                      <Icon />
                    </div>
                    <span className={`growth-card-signal ${state.solved ? 'is-solved' : 'is-problem'}`}>
                      {state.solved ? 'controlled' : card.signal}
                    </span>
                  </div>
                  <div className="growth-card-title-stack">
                    <h3 className="growth-card-title">{state.solved ? card.solution : card.problem}</h3>
                  </div>
                  <div className="growth-card-footer">
                    <span className="growth-card-metric">{state.solved ? card.metric : 'сбой процесса'}</span>
                    <RadioTower className="growth-card-radar" aria-hidden="true" />
                  </div>
                  <div className="growth-online">
                    <ShieldCheck aria-hidden="true" />
                    SYSTEM ONLINE
                  </div>
                  <div className="growth-particles" aria-hidden="true">
                    {Array.from({ length: 9 }).map((_, particleIndex) => (
                      <span key={particleIndex} />
                    ))}
                  </div>
                </article>
              );
            })}
          </div>
        </div>

        <div className="growth-pain-bottom">
          <div className="growth-pain-caption" aria-live="polite">
            {copyPhases.map((text, index) => (
              <p className={phase === index ? 'is-active' : ''} key={text}>
                {text}
              </p>
            ))}
          </div>
          <div className="growth-pain-axis" aria-hidden="true">
            <span className={phase === 0 ? 'is-active' : ''}>ХАОС</span>
            <span className={phase === 1 ? 'is-active' : ''}>ЦИФРОВИЗАЦИЯ</span>
            <span className={phase === 2 ? 'is-active' : ''}>КОНТРОЛЬ</span>
          </div>
        </div>
      </div>
    </section>
  );
}
