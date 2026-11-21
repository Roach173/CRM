import { motion, useMotionValue, useSpring, useTransform } from 'framer-motion';
import { ArrowDownRight, ArrowUpRight, CalendarClock, CircleDollarSign, RadioTower, UsersRound } from 'lucide-react';
import type { MouseEvent } from 'react';
import { channelBars, funnelBars, heroMetrics } from '../data/metrics';
import { AnimatedCounter } from './AnimatedCounter';

type DashboardMockupProps = {
  variant?: 'hero' | 'analytics' | 'owner' | 'system';
  activeTitle?: string;
  activeStats?: string[];
  className?: string;
};

const linePoints = '0,142 58,128 116,105 174,116 232,74 290,82 348,62 406,88 464,52 522,45 580,24';

function MetricTile({ label, value, suffix, compact, delta }: (typeof heroMetrics)[number]) {
  const positive = !delta.startsWith('-');

  return (
    <motion.div
      className="rounded-lg border border-white/10 bg-white/[0.06] p-3 shadow-[0_20px_70px_rgba(0,0,0,.2)]"
      initial={{ opacity: 0, y: 14 }}
      transition={{ duration: 0.48 }}
      viewport={{ once: true }}
      whileInView={{ opacity: 1, y: 0 }}
      whileHover={{ y: -4, scale: 1.015 }}
    >
      <p className="text-xs font-bold text-white/70">{label}</p>
      <div className="mt-2 flex items-end justify-between gap-3">
        <AnimatedCounter className="text-xl font-black text-white sm:text-2xl" compact={compact} suffix={suffix} value={value} />
        <span className={`flex items-center gap-1 text-xs font-black ${positive ? 'text-[#b7ff3c]' : 'text-red-300'}`}>
          {positive ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
          {delta}
        </span>
      </div>
    </motion.div>
  );
}

function MiniBar({ name, value }: { name: string; value: number }) {
  return (
    <div className="grid grid-cols-[86px_1fr_34px] items-center gap-3 text-xs">
      <span className="truncate text-white/72">{name}</span>
      <div className="h-2 overflow-hidden rounded-full bg-white/10">
        <motion.div
          className="h-full rounded-full bg-[#b7ff3c]"
          initial={{ width: 0 }}
          transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }}
          viewport={{ once: true }}
          whileInView={{ width: `${value}%` }}
        />
      </div>
      <b className="text-white">{value}%</b>
    </div>
  );
}

export function DashboardMockup({ variant = 'hero', activeTitle = 'Продажи', activeStats = [], className = '' }: DashboardMockupProps) {
  const mouseX = useMotionValue(0);
  const mouseY = useMotionValue(0);
  const springX = useSpring(mouseX, { damping: 22, stiffness: 120 });
  const springY = useSpring(mouseY, { damping: 22, stiffness: 120 });
  const rotateY = useTransform(springX, [-0.5, 0.5], [-5, 5]);
  const rotateX = useTransform(springY, [-0.5, 0.5], [4, -4]);
  const isOwner = variant === 'owner';
  const isAnalytics = variant === 'analytics';

  const onMouseMove = (event: MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    mouseX.set((event.clientX - rect.left) / rect.width - 0.5);
    mouseY.set((event.clientY - rect.top) / rect.height - 0.5);
  };

  const onMouseLeave = () => {
    mouseX.set(0);
    mouseY.set(0);
  };

  return (
    <motion.div
      className={`landing-dashboard relative w-full max-w-full rounded-xl border border-black/10 bg-[#080b10] p-3 text-white shadow-[0_32px_110px_rgba(0,0,0,.28)] ${className}`}
      initial={{ opacity: 0, x: 24, scale: 0.97 }}
      whileInView={{ opacity: 1, x: 0, scale: 1 }}
      onMouseLeave={onMouseLeave}
      onMouseMove={onMouseMove}
      style={{ rotateX, rotateY, transformPerspective: 1100 }}
      transition={{ duration: 0.78, ease: [0.16, 1, 0.3, 1] }}
      viewport={{ amount: 0.22, once: true }}
    >
      <div className="absolute -inset-6 -z-10 rounded-[28px] bg-[radial-gradient(circle_at_20%_20%,rgba(183,255,60,.26),transparent_34%),radial-gradient(circle_at_80%_70%,rgba(42,120,255,.18),transparent_34%)] blur-2xl" />
      <div className="overflow-hidden rounded-lg border border-white/10 bg-[#0a0f16]">
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="grid h-9 w-9 place-items-center rounded-lg bg-[#b7ff3c] text-black">
              <RadioTower className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm font-black">Command CRM</p>
              <p className="text-xs text-white/68">Панель владельца</p>
            </div>
          </div>
          <div className="hidden rounded-full border border-[#b7ff3c]/30 bg-[#b7ff3c]/10 px-3 py-1 text-xs font-black text-[#dfff99] sm:block">
            LIVE CONTROL
          </div>
        </div>

        <div className="grid gap-3 p-3">
          <div className="dashboard-metrics-grid grid grid-cols-2 gap-3 xl:grid-cols-4">
            {heroMetrics.map((metric) => (
              <MetricTile key={metric.label} {...metric} />
            ))}
          </div>

          <div className="dashboard-main-grid grid gap-3 lg:grid-cols-[1.2fr_.8fr]">
            <motion.div className="dashboard-chart-card rounded-lg border border-white/10 bg-white/[0.045] p-3" initial={{ opacity: 0, y: 14 }} viewport={{ once: true }} whileInView={{ opacity: 1, y: 0 }}>
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <p className="text-sm font-black">{isAnalytics ? 'Деньги, каналы, отток' : 'Выручка и заявки'}</p>
                  <p className="text-xs text-white/68">не ощущение, а ежедневный срез</p>
                </div>
                <CircleDollarSign className="h-5 w-5 text-[#b7ff3c]" />
              </div>
              <svg className="dashboard-chart h-36 w-full overflow-visible xl:h-40" fill="none" viewBox="0 0 580 170">
                <defs>
                  <linearGradient id={`line-${variant}`} x1="0" x2="580" y1="0" y2="0">
                    <stop stopColor="#b7ff3c" />
                    <stop offset=".55" stopColor="#39a7ff" />
                    <stop offset="1" stopColor="#8c5cff" />
                  </linearGradient>
                  <linearGradient id={`area-${variant}`} x1="0" x2="0" y1="0" y2="1">
                    <stop stopColor="#b7ff3c" stopOpacity=".2" />
                    <stop offset="1" stopColor="#b7ff3c" stopOpacity="0" />
                  </linearGradient>
                </defs>
                {Array.from({ length: 7 }).map((_, index) => (
                  <line key={`grid-${index}`} stroke="white" strokeOpacity=".06" x1="0" x2="580" y1={index * 26} y2={index * 26} />
                ))}
                <path d={`M ${linePoints} L 580,170 L 0,170 Z`} fill={`url(#area-${variant})`} />
                <motion.polyline
                  animate={{ pathLength: 1 }}
                  initial={{ pathLength: 0 }}
                  points={linePoints}
                  stroke={`url(#line-${variant})`}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="5"
                  transition={{ duration: 1.35, ease: 'easeInOut' }}
                />
                <circle cx="464" cy="52" fill="#b7ff3c" r="7" />
              </svg>
            </motion.div>

            <motion.div className="grid gap-3" initial={{ opacity: 0, y: 14 }} viewport={{ once: true }} whileInView={{ opacity: 1, y: 0 }}>
              <div className="dashboard-today-card rounded-lg border border-white/10 bg-white/[0.045] p-3">
                <div className="mb-4 flex items-center justify-between">
                  <p className="text-sm font-black">{isOwner ? 'Сегодня' : `${activeTitle}: контроль`}</p>
                  <CalendarClock className="h-5 w-5 text-[#b7ff3c]" />
                </div>
                <div className="space-y-2">
                  {(activeStats.length ? activeStats : ['Новые заявки', 'Ближайшие занятия', 'Долги', 'Загрузка']).map((stat, index) => (
                    <div className="flex items-center justify-between rounded-md bg-white/[0.055] px-3 py-2 text-xs" key={stat}>
                      <span className="text-white/72">{stat}</span>
                      <b>{['184', '27', '426K', '78%'][index] ?? 'OK'}</b>
                    </div>
                  ))}
                </div>
              </div>

              <div className="dashboard-funnel-card rounded-lg border border-white/10 bg-white/[0.045] p-3">
                <p className="mb-4 text-sm font-black">{isAnalytics ? 'Эффективность каналов' : 'Воронка продаж'}</p>
                <div className="space-y-2">
                  {isAnalytics
                    ? channelBars.map((bar) => <MiniBar key={bar.name} {...bar} />)
                    : funnelBars.map((value, index) => <MiniBar key={value} name={['Заявка', 'Контакт', 'Пробный', 'Счет', 'Оплата'][index]} value={value} />)}
                </div>
              </div>
            </motion.div>
          </div>

          <motion.div className="dashboard-summary-row grid gap-3 md:grid-cols-3" initial={{ opacity: 0, y: 14 }} viewport={{ once: true }} whileInView={{ opacity: 1, y: 0 }}>
            {['Ближайшие занятия: 27', 'Долги: 426K ₸', 'Риски оттока: 18'].map((item) => (
              <div className="flex items-center justify-between rounded-lg border border-white/10 bg-white/[0.045] p-3 text-xs font-bold" key={item}>
                <span className="text-white/72">{item}</span>
                <UsersRound className="h-4 w-4 text-[#b7ff3c]" />
              </div>
            ))}
          </motion.div>
        </div>
      </div>
    </motion.div>
  );
}
