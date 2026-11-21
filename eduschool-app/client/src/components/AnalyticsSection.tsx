import { motion } from 'framer-motion';
import { analyticsMetrics } from '../data/metrics';
import { AnimatedCounter } from './AnimatedCounter';
import { DashboardMockup } from './DashboardMockup';
import { SectionWrapper } from './SectionWrapper';

const proofLines = [
  'Не “кажется, реклама работает”, а точная цифра.',
  'Не “админ вроде звонит”, а отчет по каждому касанию.',
  'Не “ученики уходят”, а понятная причина оттока.',
];

const toneClass = {
  blue: 'text-blue-600',
  green: 'text-lime-600',
  red: 'text-red-600',
  violet: 'text-violet-600',
};

export function AnalyticsSection() {
  return (
    <SectionWrapper className="bg-white" contentClassName="grid items-center gap-10 lg:grid-cols-[.95fr_1.05fr]" id="analytics">
      <div className="absolute inset-0 -z-10 bg-[linear-gradient(90deg,rgba(0,0,0,.04)_1px,transparent_1px),linear-gradient(0deg,rgba(0,0,0,.04)_1px,transparent_1px)] bg-[size:42px_42px]" />
      <div>
        <motion.p className="text-xs font-black uppercase tracking-[0.18em] text-black/60" variants={{ hidden: { opacity: 0, y: 18 }, show: { opacity: 1, y: 0 } }}>
          цифровая аналитика
        </motion.p>
        <motion.h2 className="mt-4 max-w-3xl text-4xl font-black leading-none text-black sm:text-6xl" variants={{ hidden: { opacity: 0, y: 26 }, show: { opacity: 1, y: 0 } }}>
          Вы не можете управлять тем, что не измеряете
        </motion.h2>
        <motion.p className="mt-6 max-w-2xl text-lg font-semibold leading-8 text-black/62" variants={{ hidden: { opacity: 0, y: 18 }, show: { opacity: 1, y: 0 } }}>
          CRM показывает не просто красивые графики. Она показывает, где школа зарабатывает, где сливает бюджет и кто тормозит рост.
        </motion.p>

        <div className="mt-8 grid gap-3 sm:grid-cols-2">
          {proofLines.map((line) => (
            <motion.div className="rounded-lg border border-black/10 bg-[#f7f7f1] p-4 text-sm font-black text-black" key={line} variants={{ hidden: { opacity: 0, y: 16 }, show: { opacity: 1, y: 0 } }}>
              {line}
            </motion.div>
          ))}
        </div>
      </div>

      <div>
        <DashboardMockup variant="analytics" />
        <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
          {analyticsMetrics.map((metric) => (
            <motion.div className="rounded-lg border border-black/10 bg-[#f7f7f1] p-3" key={metric.label} variants={{ hidden: { opacity: 0, y: 14 }, show: { opacity: 1, y: 0 } }} whileHover={{ y: -4 }}>
              <p className="text-[11px] font-black leading-tight text-black/62">{metric.label}</p>
              <AnimatedCounter
                className={`mt-2 block text-xl font-black ${toneClass[metric.tone as keyof typeof toneClass]}`}
                compact={metric.compact}
                decimals={String(metric.value).includes('.') ? 1 : 0}
                suffix={metric.suffix}
                value={metric.value}
              />
            </motion.div>
          ))}
        </div>
      </div>
    </SectionWrapper>
  );
}
