import React, { useEffect, useState, useRef, useCallback } from "react";
import { motion, AnimatePresence, useMotionValue, useSpring, useTransform, useMotionTemplate } from "framer-motion";
import {
  ArrowRight,
  Building2,
  CalendarDays,
  CheckCircle2,
  Clock3,
  CreditCard,
  GraduationCap,
  LineChart,
  Mail,
  Menu,
  MessageCircle,
  Rocket,
  Send,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  UsersRound,
  WalletCards,
  X,
  Instagram,
  Youtube
} from "lucide-react";
import { CTAForm } from '../components/CTAForm';
import { Logo } from '../components/Logo';
import { useSmoothScroll } from '../hooks/useSmoothScroll';
import { ParticlesFieldBackground } from "../components/ParticlesFieldBackground";


const fadeUp = {
  hidden: { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0 },
};

const modules = [
  {
    icon: UsersRound,
    title: "Ученики и лиды",
    text: "Единая база учеников, заявок, родителей, статусов, оплат и истории общения.",
  },
  {
    icon: CalendarDays,
    title: "Расписание",
    text: "Группы, кабинеты, преподаватели, замены и переносы без хаоса в таблицах.",
  },
  {
    icon: WalletCards,
    title: "Оплаты",
    text: "Контроль оплат, задолженностей, абонементов и финансовой дисциплины школы.",
  },
  {
    icon: MessageCircle,
    title: "Коммуникации",
    text: "WhatsApp, Telegram, email и напоминания в одном рабочем процессе.",
  },
  {
    icon: LineChart,
    title: "Маркетинг",
    text: "UTM, заявки, каналы, конверсии, эффективность менеджеров и кампаний.",
  },
  {
    icon: ShieldCheck,
    title: "Доступы",
    text: "Владелец, админ, менеджер, преподаватель и кассир видят только нужное.",
  },
];

const roles = [
  "Владелец видит деньги, рост и слабые места школы",
  "Администратор управляет расписанием, учениками и группами",
  "Менеджер обрабатывает заявки и ведет продажи",
  "Преподаватель видит свои занятия и посещаемость",
];

const automationCards = [
  {
    icon: MessageCircle,
    title: "Заявки из соцсетей и мессенджеров",
    text: "Instagram, WhatsApp, Telegram и сайт собираются в единую очередь. Менеджер видит источник, статус и следующий шаг.",
    metric: "+32%",
    metricLabel: "быстрее обработка заявок",
    progress: 82,
  },
  {
    icon: Clock3,
    title: "Автоматические напоминания",
    text: "Ученики получают напоминания о занятиях, оплатах и переносах. Администратору не нужно вручную писать каждому.",
    metric: "−40%",
    metricLabel: "меньше ручной рутины",
    progress: 74,
  },
  {
    icon: WalletCards,
    title: "Контроль оплат и долгов",
    text: "CRM подсвечивает просрочки, активные абонементы и долги по группам, филиалам и отдельным ученикам.",
    metric: "+18%",
    metricLabel: "лучше собираемость оплат",
    progress: 68,
  },
  {
    icon: LineChart,
    title: "Управленческая аналитика",
    text: "Владелец видит эффективность каналов, менеджеров, групп и преподавателей без ручных отчетов в таблицах.",
    metric: "1 окно",
    metricLabel: "для контроля всей школы",
    progress: 94,
  },
];

const pricing = [
  {
    name: "Start",
    price: "от 15 000 сом / мес",
    desc: "Когда нужно заменить Excel, WhatsApp-хаос и ручные списки.",
    items: ["База учеников", "Группы и расписание", "Оплаты", "Базовая аналитика"],
    type: "audit" as const,
  },
  {
    name: "Growth",
    price: "от 20 000 сом / мес",
    desc: "Когда появляются филиалы, отдел продаж и маркетинговые каналы.",
    items: ["Все из Start", "CRM заявок", "UTM и интеграции", "Роли сотрудников", "Расширенная аналитика"],
    popular: true,
    type: "demo" as const,
  },
  {
    name: "Enterprise",
    price: "по запросу",
    desc: "Когда нужна гибкость, контроль, автоматизация и кастомные процессы.",
    items: ["Все из Growth", "Филиалы", "Кастомные права", "API и интеграции", "Персональное внедрение"],
    type: "consultation" as const,
  },
];

interface SectionProps {
  children: React.ReactNode;
  className?: string;
  innerClassName?: string;
  id?: string;
}

function Section({
  children,
  className = "",
  innerClassName = "",
  id,
}: SectionProps) {
  return (
    <section 
      id={id}
      data-header-theme={className.includes("#071815") ? "dark" : "light"} 
      className={`relative isolate overflow-hidden scroll-mt-16 px-4 py-12 sm:px-6 sm:py-14 lg:px-8 lg:py-16 xl:py-20 ${className}`}
    >
      <div className={`mx-auto w-full max-w-7xl ${innerClassName}`}>{children}</div>
    </section>
  );
}

function SectionHeading({
  eyebrow,
  title,
  text,
  light = false,
  centered = false,
}: {
  eyebrow: string;
  title: string;
  text?: string;
  light?: boolean;
  centered?: boolean;
}) {
  return (
    <div className={`${centered ? "mx-auto text-center" : ""} max-w-3xl`}>
      <p className={`mb-2.5 text-xs font-bold uppercase tracking-[0.22em] ${light ? "text-emerald-300" : "text-emerald-700"}`}>{eyebrow}</p>
      <h2 className={`text-2xl font-black tracking-tight sm:text-3xl lg:text-4xl ${light ? "text-white" : "text-slate-950"}`}>{title}</h2>
      {text && <p className={`mt-4 text-sm leading-6 sm:text-base ${light ? "text-slate-300" : "text-slate-600"}`}>{text}</p>}
    </div>
  );
}

function AnimatedMetric({
  value,
  suffix = "",
  decimals = 0,
}: {
  value: number;
  suffix?: string;
  decimals?: number;
}) {
  const [current, setCurrent] = useState(0);

  useEffect(() => {
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) {
      setCurrent(value);
      return;
    }

    let frame = 0;
    const duration = 950;
    const start = performance.now();

    const tick = (now: number) => {
      const progress = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setCurrent(value * eased);
      if (progress < 1) frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value]);

  return <>{current.toFixed(decimals)}{suffix}</>;
}

function MotionCard({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.35 }}
      whileHover={{ y: -3, scale: 1.01 }}
      transition={{ duration: 0.38, ease: "easeOut" }}
      className={`transform-gpu will-change-transform ${className}`}
    >
      {children}
    </motion.div>
  );
}

function Sparkline({ color = "emerald" }: { color?: "emerald" | "cyan" | "violet" | "amber" }) {
  const colorClass = {
    emerald: "from-emerald-400 to-emerald-200",
    cyan: "from-cyan-400 to-cyan-200",
    violet: "from-violet-400 to-violet-200",
    amber: "from-amber-400 to-amber-200",
  }[color];

  return (
    <div className="mt-2.5 flex h-6 items-end gap-1 overflow-hidden">
      {[30, 46, 38, 62, 44, 72, 58, 78].map((height, i) => (
        <motion.span
          key={i}
          initial={{ height: 0, opacity: 0.35 }}
          whileInView={{ height: `${height}%`, opacity: 0.9 }}
          viewport={{ once: true }}
          transition={{ duration: 0.55, delay: i * 0.04, ease: "easeOut" }}
          className={`block w-full rounded-full bg-gradient-to-t ${colorClass}`}
        />
      ))}
    </div>
  );
}

function ResponsiveConversionChart({ compact = false }: { compact?: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 400, height: 120 });

  useEffect(() => {
    if (!containerRef.current) return;
    
    const resizeObserver = new ResizeObserver((entries) => {
      if (!entries || entries.length === 0) return;
      const rect = entries[0].target.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setDimensions({ width: rect.width, height: rect.height });
      }
    });

    resizeObserver.observe(containerRef.current);
    return () => resizeObserver.disconnect();
  }, []);

  const { width, height } = dimensions;

  const data = [22, 36, 43, 50, 62, 76, 80, 66, 54, 68, 78, 80, 86];
  const n = data.length;
  const minData = Math.min(...data);
  const maxData = Math.max(...data);
  const rangeData = maxData - minData || 1;

  // Responsive padding parameters
  const paddingLeft = compact ? 8 : 16;
  const paddingRight = compact ? 8 : 16;
  const paddingTop = compact ? 12 : 20;
  const paddingBottom = compact ? 12 : 16;

  const chartWidth = width - paddingLeft - paddingRight;
  const chartHeight = height - paddingTop - paddingBottom;

  const points = data.map((val, i) => {
    const x = paddingLeft + i * (chartWidth / (n - 1));
    const y = paddingTop + (1 - (val - minData) / rangeData) * chartHeight;
    return { x, y };
  });

  const getBezierPath = (pts: { x: number; y: number }[]) => {
    if (pts.length === 0) return "";
    let path = `M ${pts[0].x} ${pts[0].y}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i];
      const p1 = pts[i + 1];
      const cp1x = p0.x + (p1.x - p0.x) * 0.35;
      const cp1y = p0.y;
      const cp2x = p1.x - (p1.x - p0.x) * 0.35;
      const cp2y = p1.y;
      path += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p1.x} ${p1.y}`;
    }
    return path;
  };

  const linePath = getBezierPath(points);
  const areaPath = points.length > 0 
    ? `${linePath} L ${points[n - 1].x} ${height - paddingBottom} L ${points[0].x} ${height - paddingBottom} Z` 
    : "";
  const activePoint = points[9]; // Active marker on the 10th point (value 68)

  // Dynamic grid lines
  const gridY1 = paddingTop + chartHeight * 0.25;
  const gridY2 = paddingTop + chartHeight * 0.5;
  const gridY3 = paddingTop + chartHeight * 0.75;
  const gridX1 = paddingLeft;
  const gridX2 = width - paddingRight;

  return (
    <div 
      ref={containerRef}
      className={`${compact ? "h-28" : "h-28 xl:h-36"} relative w-full overflow-hidden rounded-xl bg-gradient-to-b from-emerald-400/5 to-transparent`}
    >
      <svg 
        viewBox={`0 0 ${width} ${height}`} 
        className="absolute inset-0 h-full w-full overflow-visible pointer-events-none"
      >
        <defs>
          <linearGradient id="lineFill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="rgb(16 185 129)" stopOpacity="0.25" />
            <stop offset="100%" stopColor="rgb(16 185 129)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Dynamic Responsive Grid Lines */}
        <line x1={gridX1} y1={gridY1} x2={gridX2} y2={gridY1} stroke="rgba(255,255,255,0.06)" strokeWidth="1" />
        <line x1={gridX1} y1={gridY2} x2={gridX2} y2={gridY2} stroke="rgba(255,255,255,0.06)" strokeWidth="1" />
        <line x1={gridX1} y1={gridY3} x2={gridX2} y2={gridY3} stroke="rgba(255,255,255,0.06)" strokeWidth="1" />

        {/* Area Gradient Fill */}
        {areaPath && (
          <motion.path 
            d={areaPath} 
            fill="url(#lineFill)"
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true }}
            transition={{ duration: 1.5, ease: "easeOut" }}
          />
        )}

        {/* Curve Line */}
        {linePath && (
          <motion.path
            d={linePath}
            fill="none"
            stroke="rgb(16 185 129)"
            strokeWidth="2"
            strokeLinecap="round"
            initial={{ pathLength: 0, opacity: 0 }}
            whileInView={{ pathLength: 1, opacity: 1 }}
            viewport={{ once: true }}
            transition={{ duration: 1.25, ease: "easeInOut" }}
          />
        )}

        {/* Perfect Circle Active Point */}
        {activePoint && (
          <g>
            {/* Outer pulsating glow ring */}
            <motion.circle
              cx={activePoint.x}
              cy={activePoint.y}
              fill="rgba(16, 185, 129, 0.25)"
              initial={{ r: 0 }}
              animate={{ r: [6, 12, 6] }}
              transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
            />
            {/* Solid central circle with border */}
            <motion.circle
              cx={activePoint.x}
              cy={activePoint.y}
              fill="#07120f"
              stroke="rgb(52, 211, 153)"
              strokeWidth="2"
              initial={{ r: 0 }}
              animate={{ r: 4 }}
              transition={{ duration: 0.35, delay: 0.8 }}
            />
          </g>
        )}
      </svg>
    </div>
  );
}

function DashboardMockup({ compact = false, onOpenForm }: { compact?: boolean; onOpenForm: (type: 'audit' | 'demo' | 'consultation') => void }) {
  const kpis = [
    { label: "Заявки", value: 184, suffix: "", decimals: 0, detail: "за неделю", delta: "+18%", icon: UsersRound, color: "emerald" as const },
    { label: "Выручка", value: 5.24, suffix: "M ⃀", decimals: 2, detail: "за месяц", delta: "+32%", icon: CreditCard, color: "violet" as const },
    { label: "Группы", value: 44, suffix: "", decimals: 0, detail: "активно", delta: "+6%", icon: GraduationCap, color: "cyan" as const },
    { label: "Доля оплат", value: 92, suffix: "%", decimals: 0, detail: "конверсия", delta: "+4.2%", icon: WalletCards, color: "amber" as const },
  ];

  const schedule = [
    ["09:00", "English A2", "София Петрова", "Каб. 3", "8", "bg-emerald-400"],
    ["11:30", "IELTS Speaking", "Иван Иванов", "Online", "6", "bg-amber-400"],
    ["15:00", "Kids Starter", "Мария Смирнова", "Каб. 1", "7", "bg-violet-400"],
    ["18:30", "Grammar B1", "Алексей Кузнецов", "Каб. 2", "10", "bg-cyan-400"],
  ];

  const containerRef = useRef<HTMLDivElement>(null);
  
  // Motion values for tracking cursor and corner pressure targets
  const tl = useMotionValue(0);
  const tr = useMotionValue(0);
  const bl = useMotionValue(0);
  const br = useMotionValue(0);
  const mx = useMotionValue(0.5);
  const my = useMotionValue(0.5);
  const global = useMotionValue(0);

  // Springs with specified settings
  const tlSpring = useSpring(tl, { stiffness: 95, damping: 24, mass: 0.75 });
  const trSpring = useSpring(tr, { stiffness: 95, damping: 24, mass: 0.75 });
  const blSpring = useSpring(bl, { stiffness: 95, damping: 24, mass: 0.75 });
  const brSpring = useSpring(br, { stiffness: 95, damping: 24, mass: 0.75 });
  const globalSpring = useSpring(global, { stiffness: 95, damping: 24, mass: 0.75 });
  const mxSpring = useSpring(mx, { stiffness: 70, damping: 22, mass: 0.8 });
  const mySpring = useSpring(my, { stiffness: 70, damping: 22, mass: 0.8 });

  // Transforms mapping corner springs to 3D rotation with sinking effect on corner proximity
  const rotateX = useTransform(
    [tlSpring, trSpring, blSpring, brSpring],
    (values: unknown) => {
      const [tlVal, trVal, blVal, brVal] = values as number[];
      const top = tlVal + trVal;
      const bottom = blVal + brVal;
      return (top - bottom) * -4.2;
    }
  );

  const rotateY = useTransform(
    [tlSpring, trSpring, blSpring, brSpring],
    (values: unknown) => {
      const [tlVal, trVal, blVal, brVal] = values as number[];
      const left = tlVal + blVal;
      const right = trVal + brVal;
      return (left - right) * -4.6;
    }
  );

  // Transforms mapping global pressure state to 3D compression translations
  const scale = useTransform(globalSpring, [0, 1], [1, 0.985]);
  const pressureY = useTransform(globalSpring, [0, 1], [0, 8]);
  const boxShadow = useTransform(
    globalSpring,
    [0, 1],
    [
      "0 34px 90px rgba(0, 0, 0, 0.22)",
      "0 18px 54px rgba(0, 0, 0, 0.34)"
    ]
  );

  // Dynamic cursor-follow emerald/teal radial glass glow template
  const glowX = useTransform(mxSpring, [0, 1], [0, 100]);
  const glowY = useTransform(mySpring, [0, 1], [0, 100]);
  const glowBackground = useMotionTemplate`radial-gradient(circle at ${glowX}% ${glowY}%, rgba(52, 211, 153, 0.20), rgba(52, 211, 153, 0.08) 18%, transparent 42%)`;
  const glowOpacity = useTransform(globalSpring, [0, 1], [0.10, 0.45]);

  // Reactive border glows
  const outerBorderColor = useTransform(
    globalSpring,
    [0, 1],
    ["rgba(255, 255, 255, 0.15)", "rgba(110, 231, 183, 0.25)"]
  );
  const innerBorderColor = useTransform(
    globalSpring,
    [0, 1],
    ["rgba(255, 255, 255, 0.10)", "rgba(110, 231, 183, 0.18)"]
  );

  const [reduceMotion, setReduceMotion] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    // Detect OS reduced motion accessibility preference
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduceMotion(motionQuery.matches);
    const mListener = (e: MediaQueryListEvent) => setReduceMotion(e.matches);
    motionQuery.addEventListener("change", mListener);

    // Disable proximity on small mobile devices to respect touch layouts
    const checkMobile = () => setIsMobile(window.innerWidth < 1024);
    checkMobile();
    window.addEventListener("resize", checkMobile);

    return () => {
      motionQuery.removeEventListener("change", mListener);
      window.removeEventListener("resize", checkMobile);
    };
  }, []);

  useEffect(() => {
    if (reduceMotion || isMobile) {
      // Clear targets on static mode
      tl.set(0);
      tr.set(0);
      bl.set(0);
      br.set(0);
      global.set(0);
      mx.set(0.5);
      my.set(0.5);
      return;
    }

    const handleMouseMove = (e: MouseEvent) => {
      const container = containerRef.current;
      if (!container) return;

      const rect = container.getBoundingClientRect();
      
      // Calculate normalized cursor coordinates relative to container
      const rx = (e.clientX - rect.left) / rect.width;
      const ry = (e.clientY - rect.top) / rect.height;

      // Safe outer clamp to trigger proximity animation prior to strict hover bounding box
      const clampedRx = Math.max(-0.55, Math.min(1.55, rx));
      const clampedRy = Math.max(-0.55, Math.min(1.55, ry));

      const influenceRadius = 0.82;

      // 1. Top-Left corner: (0, 0), weight: 1.18
      const distTL = Math.hypot(clampedRx - 0, clampedRy - 0);
      const tlVal = Math.max(0, 1 - distTL / influenceRadius) * 1.18;

      // 2. Top-Right corner: (1, 0), weight: 0.94
      const distTR = Math.hypot(clampedRx - 1, clampedRy - 0);
      const trVal = Math.max(0, 1 - distTR / influenceRadius) * 0.94;

      // 3. Bottom-Left corner: (0, 1), weight: 0.86
      const distBL = Math.hypot(clampedRx - 0, clampedRy - 1);
      const blVal = Math.max(0, 1 - distBL / influenceRadius) * 0.86;

      // 4. Bottom-Right corner: (1, 1), weight: 1.08
      const distBR = Math.hypot(clampedRx - 1, clampedRy - 1);
      const brVal = Math.max(0, 1 - distBR / influenceRadius) * 1.08;

      // Global pressure drives absolute scale compression and vertical sinking
      const globalTarget = Math.max(tlVal, trVal, blVal, brVal);

      // Commit targets to motion values
      tl.set(tlVal);
      tr.set(trVal);
      bl.set(blVal);
      br.set(brVal);
      global.set(globalTarget);

      // Mouse values track current relative clamped coordinates smoothly
      mx.set(clampedRx);
      my.set(clampedRy);
    };

    const handleMouseLeave = () => {
      // Revert sluggishly back to default rested values
      tl.set(0);
      tr.set(0);
      bl.set(0);
      br.set(0);
      global.set(0);
      mx.set(0.5);
      my.set(0.5);
    };

    window.addEventListener("mousemove", handleMouseMove, { passive: true });
    document.addEventListener("mouseleave", handleMouseLeave, { passive: true });

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseleave", handleMouseLeave);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduceMotion, isMobile]);


  return (
    <motion.div
      className="w-full [perspective:1400px]"
      animate={reduceMotion ? {} : { y: [0, -5, 0] }}
      transition={{ duration: 7, repeat: Infinity, ease: "easeInOut" }}
    >
      <motion.div
        ref={containerRef}
        className="relative w-full overflow-hidden rounded-3xl border bg-white/[0.045] p-1.5 shadow-2xl"
        style={{
          transformStyle: "preserve-3d",
          rotateX: reduceMotion ? 0 : rotateX,
          rotateY: reduceMotion ? 0 : rotateY,
          scale: reduceMotion ? 1 : scale,
          y: reduceMotion ? 0 : pressureY,
          boxShadow,
          borderColor: outerBorderColor,
        }}
      >
        <motion.div
          className="relative overflow-hidden rounded-2xl border bg-[#07120f]/95 p-3.5 sm:p-4 dashboard-inner-padding"
          style={{ borderColor: innerBorderColor }}
        >
          {/* Cursor-follow inner glass glow overlay */}
          <motion.div
            className="pointer-events-none absolute inset-0 z-0"
            style={{ opacity: glowOpacity, background: glowBackground }}
          />

          <div className="relative z-10">
            <div className="mb-4 flex min-w-0 items-start justify-between gap-3 dashboard-header-margin">
              <div className="min-w-0 pl-1.5 sm:pl-2.5">
                <p className="truncate text-[10px] text-slate-400 sm:text-xs">Shamdan / Обзор</p>
                <h3 className="mt-0.5 truncate text-lg font-black tracking-tight text-white sm:text-xl">Пульс языковой школы</h3>
              </div>
              <div className="shrink-0 rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-1 text-[10px] font-medium text-emerald-200">
                <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" /> Онлайн
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
              {kpis.map((item) => {
                const Icon = item.icon;
                return (
                  <MotionCard key={item.label} className="min-w-0 rounded-xl border border-white/10 bg-white/[0.045] p-3 shadow-sm shadow-black/10 transition-colors hover:border-emerald-300/30 hover:bg-white/[0.06] kpi-card-short">
                    <div className="flex items-center gap-1.5 text-slate-300">
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-xl bg-emerald-400/10 text-emerald-300">
                        <Icon className="h-3 w-3" />
                      </span>
                      <p className="truncate text-[11px] sm:text-xs text-slate-300">{item.label}</p>
                    </div>
                    <div className="mt-2 flex items-end justify-between gap-1.5">
                      <div className="min-w-0">
                        <p className="truncate text-lg font-black text-white sm:text-xl">
                          <AnimatedMetric value={item.value} suffix={item.suffix} decimals={item.decimals} />
                        </p>
                        <p className="truncate text-[9px] text-slate-400">{item.detail}</p>
                      </div>
                      <span className="shrink-0 text-[10px] font-bold text-emerald-300">{item.delta}</span>
                    </div>
                    {!compact && (
                      <div className="hidden xl:block hide-on-short-screens">
                        <Sparkline color={item.color} />
                      </div>
                    )}
                  </MotionCard>
                );
              })}
            </div>

            <div className={`mt-2.5 grid gap-2.5 chart-grid-short ${compact ? "grid-cols-1" : "xl:grid-cols-[1.18fr_.82fr] lg:grid-cols-1"}`}>
              <div className="min-w-0 rounded-xl border border-white/10 bg-white/[0.035] p-3.5 sm:p-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <p className="truncate text-xs font-bold text-white">Конверсия по каналам</p>
                  <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] text-slate-300">Неделя</span>
                </div>

                <ResponsiveConversionChart compact={compact} />

                {!compact && (
                  <div className="mt-2.5 grid grid-cols-4 gap-1.5 rounded-xl border border-white/10 bg-white/[0.035] p-2.5 text-[10px] text-slate-300">
                    {[
                      ["Сайт", "42%", "bg-emerald-400"],
                      ["Insta", "31%", "bg-blue-400"],
                      ["Реклама", "28%", "bg-orange-300"],
                      ["Реком.", "21%", "bg-yellow-300"],
                    ].map(([name, value, dot]) => (
                      <div key={name} className="min-w-0">
                        <p className="flex items-center gap-1.5 truncate text-slate-300"><span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />{name}</p>
                        <p className="mt-0.5 font-bold text-white">{value}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {!compact && (
                <div className="min-w-0 rounded-xl border border-white/10 bg-white/[0.035] p-3.5 sm:p-4 hidden xl:block schedule-card-padding">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <p className="truncate text-xs font-bold text-white">Расписание</p>
                    <span className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-0.5 text-[10px] text-slate-300">Занятия</span>
                  </div>

                  <div className="space-y-2 schedule-list-gap">
                    {schedule.map(([time, title, teacher, room, people, accent]) => (
                      <motion.div
                        key={time + title}
                        initial={{ opacity: 0, x: 12 }}
                        whileInView={{ opacity: 1, x: 0 }}
                        viewport={{ once: true }}
                        whileHover={{ x: 2, backgroundColor: "rgba(255,255,255,0.065)" }}
                        transition={{ duration: 0.35, ease: "easeOut" }}
                        className="relative flex min-w-0 items-center gap-2.5 overflow-hidden rounded-xl border border-white/5 bg-white/[0.045] px-2.5 py-2.5 schedule-item"
                      >
                        <span className={`absolute bottom-0 left-0 top-0 w-1 ${accent}`} />
                        <span className="w-10 shrink-0 text-xs font-bold text-white">{time}</span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs font-bold text-white">{title}</p>
                          <p className="truncate text-[10px] text-slate-400">{teacher}</p>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="text-[10px] text-slate-300">{room}</p>
                          <p className="text-[10px] text-slate-500">👥 {people}</p>
                        </div>
                      </motion.div>
                    ))}
                  </div>

                  <button 
                    className="mt-2.5 flex w-full items-center justify-between rounded-xl border border-white/10 bg-emerald-400/5 px-3.5 py-2.5 text-xs font-medium text-emerald-200 transition hover:bg-emerald-400/10 schedule-btn-short schedule-btn-hide-very-short"
                    onClick={() => onOpenForm('demo')}
                    type="button"
                  >
                    Перейти к расписанию <ArrowRight className="h-3 w-3" />
                  </button>
                </div>
              )}
            </div>

            {!compact && (
              <div className="mt-2.5 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4 hidden xl:grid bottom-metrics-short bottom-metrics-hide-very-short">
                {[
                  ["Новые лиды", "58", "+16%", UsersRound],
                  ["Посещаемость", "92%", "+9%", TrendingUp],
                  ["Выручка сегодня", "180K ⃀", "+21%", WalletCards],
                  ["Загрузка групп", "76%", "+6%", GraduationCap],
                ].map(([label, value, delta, Icon]) => {
                  const MetricIcon = Icon as typeof UsersRound;
                  return (
                    <div key={label as string} className="flex min-w-0 items-center gap-2.5 rounded-xl border border-white/10 bg-white/[0.035] p-3 hover:border-emerald-300/25 bottom-metric-card">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-emerald-400/10 text-emerald-300 bottom-metric-icon">
                        <MetricIcon className="h-4 w-4" />
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-[10px] text-slate-400">{label as string}</p>
                        <p className="mt-0.5 truncate text-base font-black text-white">{value as string} <span className="text-xs text-emerald-300">{delta as string}</span></p>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </motion.div>
      </motion.div>
    </motion.div>
  );
}

function AnalyticsLeversPanel({ onOpenForm }: { onOpenForm: (type: 'audit' | 'demo' | 'consultation') => void }) {
  const levers = [
    {
      title: "Откуда приходят ученики",
      value: "42%",
      label: "сайт и рекомендации",
      icon: LineChart,
    },
    {
      title: "Где проседают продажи",
      value: "18",
      label: "заявок без ответа",
      icon: MessageCircle,
    },
    {
      title: "Какие группы прибыльнее",
      value: "B1",
      label: "самая высокая маржа",
      icon: GraduationCap,
    },
    {
      title: "Сколько денег зависло",
      value: "426K ⃀",
      label: "просроченные оплаты",
      icon: WalletCards,
    },
  ];

  return (
    <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-white/[0.045] p-1.5 shadow-2xl shadow-emerald-950/20">
      <div className="rounded-2xl border border-white/10 bg-[#07120f]/90 p-4 sm:p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-emerald-300">Карта роста</p>
            <h3 className="mt-2 max-w-md text-xl font-black tracking-tight text-white sm:text-2xl">
              Что именно двигает прибыль школы
            </h3>
          </div>
          <span className="rounded-full border border-emerald-300/20 bg-emerald-300/10 px-2.5 py-1 text-[10px] font-bold text-emerald-200">
            Live signals
          </span>
        </div>

        <div className="mt-5 grid gap-2.5 sm:grid-cols-2">
          {levers.map((item) => {
            const Icon = item.icon;
            return (
              <div key={item.title} className="min-w-0 rounded-xl border border-white/10 bg-white/[0.04] p-3">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-300/10 text-emerald-300">
                    <Icon className="h-4 w-4" />
                  </span>
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-300 shadow-[0_0_18px_rgba(110,231,183,.65)]" />
                </div>
                <p className="text-xs leading-5 text-slate-400">{item.title}</p>
                <div className="mt-2 flex items-end justify-between gap-2">
                  <p className="text-2xl font-black text-white">{item.value}</p>
                  <p className="max-w-[100px] text-right text-[10px] leading-4 text-slate-400">{item.label}</p>
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-2.5 rounded-xl border border-white/10 bg-gradient-to-r from-emerald-300/12 via-white/[0.035] to-cyan-300/10 p-3.5 sm:p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-xs font-bold text-white">Следующее действие системы</p>
              <p className="mt-0.5 text-xs leading-5 text-slate-400">
                Поднять заявки без ответа и отправить владельцу короткий отчет по потерянной выручке.
              </p>
            </div>
            <button 
              className="w-fit rounded-xl bg-emerald-400 px-4 py-2.5 text-xs font-black text-slate-950 transition hover:bg-white active:scale-[0.98]" 
              onClick={() => onOpenForm('audit')}
              type="button"
            >
              Смотреть отчет
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

interface HeaderProps {
  onOpenForm: (type: 'audit' | 'demo' | 'consultation') => void;
  scrollRef: React.RefObject<HTMLDivElement | null>;
}

function LandingHeader({ onOpenForm, scrollRef }: HeaderProps) {
  const [scrolled, setScrolled] = useState(false);
  const [onLightSection, setOnLightSection] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    const node = scrollRef.current;
    const readHeaderState = () => {
      const nextScrolled = window.scrollY > 12 || (node?.scrollTop ?? 0) > 12;
      setScrolled(nextScrolled);

      const sampleX = Math.min(window.innerWidth - 1, Math.max(1, window.innerWidth / 2));
      const sampleY = nextScrolled ? 76 : 38;
      const stack = document.elementsFromPoint(sampleX, sampleY);
      const section = stack.find((element) => element instanceof HTMLElement && element.dataset.headerTheme) as HTMLElement | undefined;

      setOnLightSection(section?.dataset.headerTheme === "light");
    };

    readHeaderState();
    window.addEventListener("scroll", readHeaderState, { passive: true });
    node?.addEventListener("scroll", readHeaderState, { passive: true });
    window.addEventListener("resize", readHeaderState);
    return () => {
      window.removeEventListener("scroll", readHeaderState);
      node?.removeEventListener("scroll", readHeaderState);
      window.removeEventListener("resize", readHeaderState);
    };
  }, [scrollRef]);

  const isGlass = scrolled;
  const isLightGlass = isGlass && onLightSection;

  const textColor = isLightGlass ? "text-slate-950" : "text-white";

  const navTextColor = isLightGlass ? "text-slate-950/75" : "text-white/80";
  const navHoverColor = isLightGlass ? "hover:text-slate-950" : "hover:text-white";

  const headerSurface = isGlass
    ? isLightGlass
      ? "bg-white/92 shadow-[0_12px_40px_rgba(15,23,42,0.08)]"
      : "bg-[#071815]/92 shadow-[0_12px_40px_rgba(0,0,0,0.20)]"
    : "bg-transparent shadow-none";

  const logoBox = isLightGlass
    ? "bg-slate-950 text-emerald-300 shadow-[0_0_20px_rgba(16,185,129,.12)]"
    : "bg-black/82 text-emerald-300 shadow-[0_0_20px_rgba(52,211,153,.15)] ring-1 ring-emerald-300/15";

  const ghostButton = isLightGlass
    ? "border border-black/10 bg-white/38 text-slate-950 shadow-sm hover:border-black hover:bg-black hover:text-white"
    : "border border-white/12 bg-white/[0.055] text-white hover:border-white hover:bg-white hover:text-slate-950";

  const scrollTo = (id: string) => {
    const lenis = (window as any).lenis;
    if (lenis) {
      lenis.scrollTo(`#${id}`, { duration: 1.1 });
    } else {
      document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    setMobileOpen(false);
  };

  return (
    <header className={`fixed inset-x-0 top-0 z-50 border-0 px-4 transition duration-300 sm:px-6 lg:px-8 ${headerSurface}`}>
      <div
        className={`pointer-events-none absolute inset-0 transition-opacity duration-300 ${
          isGlass ? "opacity-100" : "opacity-0"
        } ${isLightGlass ? "bg-gradient-to-b from-white/72 via-white/28 to-white/8" : "bg-gradient-to-b from-white/[0.13] via-white/[0.055] to-transparent"}`}
      />
      <div
        className={`pointer-events-none absolute inset-x-8 bottom-0 h-px bg-gradient-to-r from-transparent transition-opacity duration-300 ${
          isGlass ? "opacity-100" : "opacity-0"
        } ${isLightGlass ? "via-black/[0.06]" : "via-white/[0.08]"} to-transparent`}
      />

      <div className="relative mx-auto flex h-16 w-full max-w-7xl items-center justify-between lg:grid lg:grid-cols-[1fr_auto_1fr]">
        <button onClick={() => scrollTo('top')} className="flex items-center gap-2.5 text-left lg:justify-self-start">
          <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl transition duration-300 ${logoBox}`}>
            <Logo variant="dark" size={18} />
          </span>
          <span className={`text-sm font-black leading-tight transition-colors duration-300 ${textColor}`}>
            Shamdan
          </span>
        </button>

        <nav className="hidden items-center justify-center gap-8 xl:gap-9 text-xs font-bold transition-colors duration-300 lg:flex lg:justify-self-center">
          <button onClick={() => scrollTo('modules')} className={`transition-colors duration-200 ${navTextColor} ${navHoverColor}`}>Возможности</button>
          <button onClick={() => scrollTo('analytics')} className={`transition-colors duration-200 ${navTextColor} ${navHoverColor}`}>Аналитика</button>
          <button onClick={() => scrollTo('pricing')} className={`transition-colors duration-200 ${navTextColor} ${navHoverColor}`}>Тарифы</button>
          <button onClick={() => scrollTo('demo')} className={`transition-colors duration-200 ${navTextColor} ${navHoverColor}`}>Демо</button>
        </nav>

        <div className="hidden items-center justify-end gap-3 md:flex lg:justify-self-end">
          <a href="/login" className={`rounded-xl px-4 py-2.5 text-xs font-bold transition ${ghostButton}`}>
            Войти
          </a>
          <button 
            className="rounded-xl bg-emerald-400 px-4 py-2.5 text-xs font-bold text-slate-950 transition hover:bg-white hover:scale-[1.02] active:scale-[0.98]" 
            onClick={() => onOpenForm('audit')}
            type="button"
          >
            Получить аудит
          </button>
        </div>

        <button
          aria-label={mobileOpen ? "Закрыть меню" : "Открыть меню"}
          className={`grid h-10 w-10 place-items-center rounded-xl transition lg:hidden ${
            isLightGlass ? "border border-black/10 bg-white/38 text-slate-950" : "border border-white/12 bg-white/[0.08] text-white"
          }`}
          onClick={() => setMobileOpen(!mobileOpen)}
          type="button"
        >
          {mobileOpen ? <X className="h-4.5 w-4.5" /> : <Menu className="h-4.5 w-4.5" />}
        </button>
      </div>

      <AnimatePresence>
        {mobileOpen && (
          <motion.div 
            className="absolute inset-x-0 top-16 border-t border-black/10 bg-[#071815]/95 px-4 py-5 shadow-2xl lg:hidden"
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.18 }}
          >
            <div className="grid gap-3.5">
              <button onClick={() => scrollTo('modules')} className="rounded-lg px-4 py-2.5 text-left text-xs font-bold text-white hover:bg-white/10">Возможности</button>
              <button onClick={() => scrollTo('analytics')} className="rounded-lg px-4 py-2.5 text-left text-xs font-bold text-white hover:bg-white/10">Аналитика</button>
              <button onClick={() => scrollTo('pricing')} className="rounded-lg px-4 py-2.5 text-left text-xs font-bold text-white hover:bg-white/10">Тарифы</button>
              <button onClick={() => scrollTo('demo')} className="rounded-lg px-4 py-2.5 text-left text-xs font-bold text-white hover:bg-white/10">Демо</button>
              <div className="my-1.5 h-px bg-white/10" />
              <a href="/login" className="rounded-lg border border-white/12 bg-white/[0.055] px-4 py-2.5 text-center text-xs font-bold text-white hover:bg-white hover:text-slate-950">
                Войти
              </a>
              <button 
                className="rounded-lg bg-emerald-400 px-4 py-2.5 text-center text-xs font-black text-slate-950 hover:bg-white"
                onClick={() => onOpenForm('audit')}
                type="button"
              >
                Получить аудит
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
}

export default function Landing() {
  const scrollRef = useRef<HTMLDivElement>(null);
  useSmoothScroll(scrollRef);
  const [formOpen, setFormOpen] = useState(false);
  const [formType, setFormType] = useState<'audit' | 'demo' | 'consultation'>('audit');

  const openForm = useCallback((type: 'audit' | 'demo' | 'consultation') => {
    setFormType(type);
    setFormOpen(true);
  }, []);

  const closeForm = useCallback(() => {
    setFormOpen(false);
  }, []);

  const scrollTo = (id: string) => {
    const lenis = (window as any).lenis;
    if (lenis) {
      lenis.scrollTo(`#${id}`, { duration: 1.1 });
    } else {
      document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  return (
    <div className="landing-root bg-slate-50 text-slate-950">
      <style>{`
        @media (max-height: 800px) {
          .hide-on-short-screens {
            display: none !important;
          }
          .dashboard-inner-padding {
            padding: 0.65rem !important;
          }
          .dashboard-header-margin {
            margin-bottom: 0.5rem !important;
          }
          .kpi-card-short {
            padding: 0.5rem !important;
          }
          .chart-container-short {
            height: 7.25rem !important;
          }
          .schedule-card-padding {
            padding: 0.65rem 0.75rem !important;
          }
          .schedule-list-gap > * + * {
            margin-top: 0.35rem !important;
          }
          .schedule-item {
            padding: 0.35rem 0.5rem !important;
            gap: 0.35rem !important;
          }
          .schedule-item:nth-child(n+4) {
            display: none !important;
          }
          .schedule-btn-short {
            margin-top: 0.5rem !important;
            padding: 0.35rem 0.65rem !important;
          }
          .bottom-metrics-short {
            gap: 0.35rem !important;
            margin-top: 0.5rem !important;
          }
          .bottom-metric-card {
            padding: 0.35rem 0.5rem !important;
          }
          .bottom-metric-icon {
            height: 1.5rem !important;
            width: 1.5rem !important;
          }
          .hero-padding-short {
            padding-top: 4.5rem !important; /* 72px */
            padding-bottom: 1rem !important; /* 16px */
          }
          .hero-gap-short {
            gap: 1.25rem !important;
            padding-top: 0.5rem !important;
            padding-bottom: 0.5rem !important;
          }
          .hero-space-short > * + * {
            margin-top: 1rem !important;
          }
        }
        @media (max-height: 580px) {
          .bottom-metrics-hide-very-short,
          .schedule-btn-hide-very-short {
            display: none !important;
          }
          .chart-container-short {
            height: 6.25rem !important;
          }
        }
      `}</style>
      <LandingHeader onOpenForm={openForm} scrollRef={scrollRef} />

      <main className="landing-scroll min-h-[100svh] overflow-x-hidden" ref={scrollRef}>
        {/* HERO SECTION - Viewport Fit (Header = 64px, pt-20 компенсирует его и бережет от оверлапа) */}
        <section 
          data-header-theme="dark" 
          className="relative isolate overflow-hidden bg-[#071815] px-4 pt-20 pb-8 sm:px-6 sm:pt-24 sm:pb-10 lg:px-8 lg:pt-28 lg:pb-12 min-h-svh flex flex-col justify-center hero-padding-short"
        >
          {/* Premium interactive particles background layer */}
          <ParticlesFieldBackground variant="hero" className="absolute inset-0 z-0" />


          {/* Soft background glows/gradients */}
          <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
            <div className="absolute left-1/2 top-0 h-[480px] w-[880px] -translate-x-1/2 rounded-full bg-emerald-400/20 blur-3xl" />
            <div className="absolute right-[-220px] top-24 h-[380px] w-[380px] rounded-full bg-cyan-300/10 blur-3xl" />
          </div>

          {/* Interactive content layer */}
          <div className="relative z-10 mx-auto w-full max-w-7xl flex-1 flex flex-col justify-center">
            <div className="grid items-center gap-8 py-6 lg:grid-cols-2 lg:gap-10 xl:gap-12 w-full hero-gap-short">
              <motion.div
                initial="hidden"
                animate="visible"
                variants={fadeUp}
                transition={{ duration: 0.6 }}
                className="flex min-w-0 flex-col justify-center space-y-6 py-4 hero-space-short"
              >
                <div className="min-w-0">
                  <div className="mb-4 lg:mb-5 inline-flex max-w-full items-center gap-1.5 rounded-full border border-emerald-300/25 bg-emerald-300/10 px-3 py-1 text-[11px] text-emerald-100 shadow-md shadow-emerald-950/20">
                    <Sparkles className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">Shamdan — CRM для языковых школ</span>
                  </div>

                  <h1 className="max-w-2xl text-4xl sm:text-5xl lg:text-[3.25rem] xl:text-[3.75rem] 2xl:text-[4.25rem] font-black leading-[1.12] tracking-tight text-white">
                    Управляйте языковой <br className="hidden sm:inline" />
                    школой без хаоса
                  </h1>

                  <p className="mt-4 lg:mt-5 max-w-xl text-xs sm:text-sm lg:text-base leading-relaxed text-slate-300">
                    Заявки, расписание, оплаты и аналитика — в одной системе. Без таблиц, Telegram-чатов и забытых напоминаний.
                  </p>

                  <div className="mt-6 lg:mt-8 flex flex-col gap-3 sm:flex-row">
                    <button 
                      className="group inline-flex h-11 items-center justify-center rounded-xl bg-emerald-400 px-5 text-xs font-bold text-slate-950 shadow-lg shadow-emerald-950/20 transition hover:bg-emerald-300 hover:scale-[1.01] active:scale-[0.99]"
                      onClick={() => openForm('demo')}
                      type="button"
                    >
                      Получить демо <ArrowRight className="ml-2 h-3.5 w-3.5 transition group-hover:translate-x-1" />
                    </button>
                    <button 
                      className="inline-flex h-11 items-center justify-center rounded-xl border border-emerald-300/25 bg-white/[0.03] px-5 text-xs font-bold text-white transition hover:bg-white/10 hover:border-white active:scale-[0.99]"
                      onClick={() => scrollTo('modules')}
                      type="button"
                    >
                      Посмотреть возможности
                    </button>
                  </div>
                </div>

                <div className="border-t border-white/10 pt-4 lg:pt-5">
                  <div className="grid gap-3 sm:grid-cols-3">
                    {[
                      [Rocket, "Запуск от 1 дня", "Быстрый старт и настройка"],
                      [GraduationCap, "Без сложного обучения", "Понятно всей команде"],
                      [Building2, "Подходит для филиалов", "Единые данные школ"],
                    ].map(([Icon, title, text]) => {
                      const BenefitIcon = Icon as typeof Rocket;
                      return (
                        <div key={title as string} className="min-w-0">
                          <div className="mb-1.5 flex h-7 w-7 items-center justify-center rounded-lg border border-emerald-300/20 bg-emerald-300/10 text-emerald-300">
                            <BenefitIcon className="h-3.5 w-3.5" />
                          </div>
                          <p className="truncate text-[11px] font-bold text-white">{title as string}</p>
                          <p className="mt-0.5 text-[10px] leading-4 text-slate-400">{text as string}</p>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </motion.div>

              <motion.div
                initial={{ opacity: 0, scale: 0.98, y: 12 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                transition={{ duration: 0.7, delay: 0.08 }}
                className="min-w-0 lg:pl-4 w-full max-w-2xl lg:max-w-[620px] xl:max-w-[700px] 2xl:max-w-[760px] mx-auto lg:ml-auto animate-gpu self-center"
              >
                <DashboardMockup onOpenForm={openForm} />
              </motion.div>
            </div>
          </div>
        </section>

        {/* MODULES SECTION */}
        <Section id="modules" className="bg-white">
          <SectionHeading eyebrow="Возможности" title="Все ключевые процессы языковой школы в одном рабочем пространстве" />

          <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3 lg:gap-6">
            {modules.map((module) => {
              const Icon = module.icon;
              return (
                <div 
                  key={module.title} 
                  className="group min-w-0 rounded-2xl border border-slate-200/80 bg-slate-50 p-5 sm:p-6 shadow-sm shadow-slate-100 transition duration-300 hover:-translate-y-1 hover:bg-slate-950 hover:text-white hover:shadow-xl hover:shadow-slate-200/50 hover:border-slate-300/80"
                >
                  <div className="mb-5 flex h-10 w-10 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-700 transition group-hover:bg-emerald-400 group-hover:text-slate-950">
                    <Icon className="h-5 w-5" />
                  </div>
                  <h3 className="text-lg font-bold text-slate-950 transition group-hover:text-white">{module.title}</h3>
                  <p className="mt-2.5 text-xs leading-6 text-slate-600 transition group-hover:text-slate-300 sm:text-sm">{module.text}</p>
                </div>
              );
            })}
          </div>
        </Section>

        {/* ANALYTICS SECTION */}
        <Section id="analytics" className="bg-[#071815]">
          <ParticlesFieldBackground variant="section-soft" className="absolute inset-0 z-0" />
          <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
            <div className="absolute left-[-180px] top-20 h-[380px] w-[380px] rounded-full bg-emerald-400/10 blur-3xl" />
          </div>

          <div className="relative z-10 grid gap-10 lg:grid-cols-2 lg:items-center">
            <div className="min-w-0">
              <SectionHeading
                eyebrow="Аналитика"
                title="Владелец видит не просто цифры, а рычаги роста"
                text="Система показывает, откуда приходят ученики, где проседают продажи, какие группы прибыльнее, кто из менеджеров теряет заявки и сколько денег зависло в долгах."
                light
              />

              <div className="mt-6 grid gap-2.5">
                {roles.map((role) => (
                  <div key={role} className="flex min-w-0 items-center gap-3.5 rounded-2xl border border-white/5 bg-white/[0.03] p-3.5 px-4.5 text-slate-200 text-xs sm:text-sm transition duration-300 hover:border-white/15 hover:bg-white/[0.05] hover:text-white">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-emerald-400/10 text-emerald-300">
                      <CheckCircle2 className="h-4 w-4" />
                    </span>
                    <span className="leading-relaxed font-medium">{role}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="min-w-0 w-full max-w-[620px] xl:max-w-[700px] 2xl:max-w-[760px] mx-auto lg:ml-auto">
              <AnalyticsLeversPanel onOpenForm={openForm} />
            </div>
          </div>
        </Section>

        {/* AUTOMATION SECTION */}
        <Section className="bg-slate-50">
          <div className="max-w-4xl">
            <SectionHeading
              eyebrow="Автоматизация"
              title="CRM убирает ручную рутину и ускоряет работу школы"
              text="Не просто подключение Telegram, Instagram или WhatsApp. Система автоматически собирает заявки, напоминает ученикам об оплатах, помогает менеджерам быстрее отвечать и контролирует долги."
            />
          </div>

          <div className="mt-10 grid gap-5 md:grid-cols-2 lg:grid-cols-4 lg:gap-6">
            {automationCards.map((card) => {
              const Icon = card.icon;
              return (
                <div key={card.title} className="flex min-w-0 flex-col justify-between rounded-2xl border border-slate-200/80 bg-white p-5 sm:p-6 shadow-sm shadow-slate-100 transition duration-300 hover:-translate-y-0.5 hover:shadow-md hover:shadow-slate-200/50 hover:border-slate-300/80">
                  <div>
                    <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-600">
                      <Icon className="h-5 w-5" />
                    </div>
                    <h3 className="text-base font-bold leading-tight text-slate-950">{card.title}</h3>
                    <p className="mt-2 text-xs leading-relaxed text-slate-500">{card.text}</p>
                  </div>
                  
                  <div className="mt-4 border-t border-slate-100 pt-3">
                    <div className="flex items-end justify-between">
                      <div>
                        <p className="text-xl font-black text-emerald-600">{card.metric}</p>
                        <p className="text-[9px] font-bold uppercase tracking-wider text-slate-400">{card.metricLabel}</p>
                      </div>
                      <span className="text-[10px] font-bold text-slate-400">{card.progress}%</span>
                    </div>
                    
                    <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                      <div 
                        className="h-full rounded-full bg-emerald-400" 
                        style={{ width: `${card.progress}%` }}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </Section>

        {/* PRICING SECTION */}
        <Section id="pricing" className="bg-white">
          <SectionHeading 
            eyebrow="Тарифы" 
            title="Простые тарифы под размер вашей школы" 
            text="Выберите подходящий тариф и начните контролировать все процессы уже сегодня."
            centered
          />

          <div className="mt-10 grid gap-6 lg:grid-cols-3">
            {pricing.map((tier) => (
              <div 
                key={tier.name}
                className={`relative flex flex-col justify-between rounded-3xl p-6 sm:p-7 max-w-md mx-auto lg:max-w-none w-full ${
                  tier.popular 
                    ? 'bg-slate-950 text-white shadow-xl shadow-slate-950/15 lg:scale-105 z-10' 
                    : 'border border-slate-200 bg-slate-50 text-slate-950 shadow-sm'
                }`}
              >
                {tier.popular && (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-emerald-400 px-3.5 py-0.5 text-[10px] font-black uppercase text-slate-950">
                    Популярно
                  </span>
                )}
                <div>
                  <h3 className={`text-xl font-black ${tier.popular ? 'text-white' : 'text-slate-950'}`}>{tier.name}</h3>
                  <p className={`mt-4 text-2xl font-black ${tier.popular ? 'text-emerald-300' : 'text-emerald-700'}`}>
                    {tier.price}
                  </p>
                  <p className={`mt-2.5 text-xs leading-relaxed ${tier.popular ? 'text-slate-300' : 'text-slate-500'}`}>
                    {tier.desc}
                  </p>

                  <div className={`mt-6 mb-6 h-px ${tier.popular ? 'bg-white/10' : 'bg-slate-200'}`} />

                  <ul className="space-y-3.5 text-xs font-semibold">
                    {tier.items.map((item) => (
                      <li key={item} className="flex items-center gap-2.5">
                        <CheckCircle2 className={`h-4 w-4 shrink-0 ${tier.popular ? 'text-emerald-300' : 'text-emerald-600'}`} />
                        <span className={tier.popular ? 'text-slate-200' : 'text-slate-700'}>{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <button
                  className={`mt-8 w-full rounded-xl py-3.5 text-xs font-black transition ${
                    tier.popular 
                      ? 'bg-emerald-400 text-slate-950 hover:bg-white hover:scale-[1.01] active:scale-[0.99]' 
                      : 'bg-slate-950 text-white hover:bg-emerald-400 hover:text-slate-950 hover:scale-[1.01] active:scale-[0.99]'
                  }`}
                  onClick={() => openForm(tier.type)}
                  type="button"
                >
                  Обсудить внедрение
                </button>
              </div>
            ))}
          </div>
        </Section>

        {/* SHShared dark zone wrapping both final CTA and Footer */}
        <div className="relative overflow-hidden w-full isolate">
          {/* Shared Single Background Backdrop across entire CTA + Footer */}
          <div 
            className="absolute inset-0 -z-20 pointer-events-none"
            style={{
              background: "radial-gradient(circle at 50% 25%, rgba(16, 185, 129, 0.12), transparent 55%), linear-gradient(180deg, #06251d 0%, #031410 40%, #020807 100%)"
            }}
          />
          {/* Shared single Particles background spanning the entire block */}
          <ParticlesFieldBackground variant="section-soft" className="absolute inset-0 z-0" opacity={0.15} />

          {/* FINAL CTA SECTION (transparent background, relative inside the shared zone) */}
          <Section id="demo" className="relative !bg-transparent">
            <div className="relative z-10 mx-auto max-w-4xl text-center">
              <span className="inline-flex items-center gap-2 rounded-full border border-emerald-300/25 bg-emerald-300/10 px-3.5 py-1.5 text-[10px] font-bold uppercase tracking-wider text-emerald-200">
                Попробуйте Shamdan
              </span>
              <h2 className="mt-5 text-3xl font-black leading-none text-white sm:text-5xl">
                Покажем, как система будет работать именно у вас
              </h2>
              <p className="mx-auto mt-5 max-w-2xl text-sm font-semibold leading-7 text-slate-300 sm:text-base">
                Запишитесь на презентацию. За 20 минут разберем структуру вашей школы и покажем реальные сценарии управления без хаоса. Это бесплатно и ни к чему вас не обязывает.
              </p>
              
              <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
                <button 
                  className="inline-flex justify-center items-center rounded-xl bg-emerald-400 px-6 py-4 text-xs font-bold text-slate-950 shadow-lg shadow-emerald-950/20 transition hover:bg-white hover:scale-[1.01] active:scale-[0.99]"
                  onClick={() => openForm('demo')}
                  type="button"
                >
                  Запросить демо <ArrowRight className="ml-2 h-4 w-4" />
                </button>
                <button 
                  className="rounded-xl border border-white/15 bg-white/[0.03] px-6 py-4 text-xs font-bold text-white transition hover:bg-white/10 hover:border-white hover:scale-[1.01] active:scale-[0.99]"
                  onClick={() => openForm('audit')}
                  type="button"
                >
                  Получить бесплатный аудит
                </button>
              </div>
            </div>
          </Section>

          {/* FOOTER SECTION (completely transparent background sitting inside the same container) */}
          <footer className="relative px-4 py-10 sm:py-12 text-slate-400 bg-transparent overflow-hidden">

            <div className="mx-auto w-full max-w-7xl">
              <div className="grid grid-cols-1 gap-y-10 gap-x-8 md:grid-cols-2 lg:grid-cols-[1.35fr_0.7fr_0.85fr_1.2fr] xl:gap-x-12">
                
                {/* Brand Column */}
                <div className="flex flex-col">
                  <div className="flex items-center gap-2">
                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-black/82 text-emerald-300 shadow-[0_0_20px_rgba(52,211,153,.15)] ring-1 ring-emerald-300/15">
                      <Logo variant="dark" size={18} />
                    </span>
                    <div className="text-sm font-black leading-tight text-white">
                      Shamdan
                    </div>
                  </div>
                  <p className="mt-3 text-xs leading-relaxed text-slate-400 font-medium">
                    Shamdan (Шамдан) — CRM для языковых школ: заявки, ученики, расписание, оплаты, преподаватели, филиалы, интеграции и аналитика в одной системе.
                  </p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <span className="rounded-full bg-emerald-400/10 px-2.5 py-1 text-[10px] font-semibold text-emerald-300 ring-1 ring-emerald-400/20">
                      Запуск от 1 дня
                    </span>
                    <span className="rounded-full bg-cyan-400/10 px-2.5 py-1 text-[10px] font-semibold text-cyan-300 ring-1 ring-cyan-400/20">
                      Для школ и филиалов
                    </span>
                    <span className="rounded-full bg-white/5 px-2.5 py-1 text-[10px] font-semibold text-slate-300 ring-1 ring-white/10">
                      KGS / сом
                    </span>
                  </div>
                </div>

                {/* Product Links */}
                <div className="flex flex-col">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-white">Продукт</h4>
                  <ul className="mt-4 space-y-2.5 text-xs font-semibold text-slate-400">
                    <li>
                      <button onClick={() => scrollTo('modules')} className="transition hover:text-emerald-300 text-left">
                        Возможности
                      </button>
                    </li>
                    <li>
                      <button onClick={() => scrollTo('analytics')} className="transition hover:text-emerald-300 text-left">
                        Аналитика
                      </button>
                    </li>
                    <li>
                      <button onClick={() => scrollTo('pricing')} className="transition hover:text-emerald-300 text-left">
                        Тарифы
                      </button>
                    </li>
                    <li>
                      <button onClick={() => scrollTo('demo')} className="transition hover:text-emerald-300 text-left">
                        Демо
                      </button>
                    </li>
                  </ul>
                </div>

                {/* Use Cases / For School */}
                <div className="flex flex-col">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-white">Для школы</h4>
                  <ul className="mt-4 space-y-2.5 text-xs font-semibold text-slate-400">
                    <li>
                      <span className="transition hover:text-slate-200 cursor-default">
                        Управление заявками
                      </span>
                    </li>
                    <li>
                      <span className="transition hover:text-slate-200 cursor-default">
                        Расписание занятий
                      </span>
                    </li>
                    <li>
                      <span className="transition hover:text-slate-200 cursor-default">
                        Контроль оплат
                      </span>
                    </li>
                    <li>
                      <span className="transition hover:text-slate-200 cursor-default">
                        Маркетинг и UTM
                      </span>
                    </li>
                    <li>
                      <span className="transition hover:text-slate-200 cursor-default">
                        Роли сотрудников
                      </span>
                    </li>
                  </ul>
                </div>

                {/* Contacts & Socials */}
                <div className="flex flex-col lg:justify-self-end w-full lg:max-w-sm">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-white">Связь</h4>
                  <div className="mt-4 flex gap-2.5">
                    <a 
                      href="#" 
                      aria-label="Telegram"
                      className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-slate-300 transition hover:bg-emerald-400 hover:text-slate-950 hover:border-emerald-400 hover:scale-105"
                    >
                      <Send className="h-4 w-4" />
                    </a>
                    <a 
                      href="#" 
                      aria-label="Instagram"
                      className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-slate-300 transition hover:bg-emerald-400 hover:text-slate-950 hover:border-emerald-400 hover:scale-105"
                    >
                      <Instagram className="h-4 w-4" />
                    </a>
                    <a 
                      href="#" 
                      aria-label="YouTube"
                      className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-slate-300 transition hover:bg-emerald-400 hover:text-slate-950 hover:border-emerald-400 hover:scale-105"
                    >
                      <Youtube className="h-4 w-4" />
                    </a>
                    <a 
                      href="mailto:hello@linguacrm.com" 
                      aria-label="Email"
                      className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] text-slate-300 transition hover:bg-emerald-400 hover:text-slate-950 hover:border-emerald-400 hover:scale-105"
                    >
                      <Mail className="h-4 w-4" />
                    </a>
                  </div>
                  <div className="mt-5 max-w-[360px] w-full">
                    <button 
                      onClick={() => openForm('audit')}
                      className="inline-flex w-full items-center justify-center rounded-xl bg-emerald-400 px-4 py-3 text-xs font-black text-slate-950 transition hover:bg-white hover:scale-[1.01] active:scale-[0.99] gap-1.5"
                      type="button"
                    >
                      Получить аудит школы <ArrowRight className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>

              </div>

              {/* Bottom Row */}
              <div className="mt-12 flex flex-col gap-4 border-t border-white/10 pt-6 md:flex-row md:items-center md:justify-between text-[10px] text-slate-400 font-semibold">
                <p>© 2026 Shamdan. Все права защищены.</p>
                <div className="flex gap-6">
                  <a href="#" className="hover:text-slate-200 transition">Политика конфиденциальности</a>
                  <a href="#" className="hover:text-slate-200 transition">Условия использования</a>
                </div>
              </div>
            </div>
          </footer>
        </div>
      </main>

      <CTAForm onClose={closeForm} open={formOpen} type={formType} />
    </div>
  );
}
