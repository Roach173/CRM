import { motion } from 'framer-motion';
import { ArrowRight } from 'lucide-react';
import type { CTAType } from '../data/features';
import { AnimatedCounter } from './AnimatedCounter';
import { SectionWrapper } from './SectionWrapper';

type FinalCTAProps = {
  onOpenForm: (type: CTAType) => void;
};

export function FinalCTA({ onOpenForm }: FinalCTAProps) {
  return (
    <SectionWrapper className="bg-black text-white" dark>
      <div className="absolute inset-0 -z-10 bg-[radial-gradient(circle_at_50%_10%,rgba(183,255,60,.18),transparent_32%)]" />
      <div className="mx-auto max-w-5xl text-center">
        <motion.div className="mx-auto mb-8 grid max-w-3xl grid-cols-3 gap-3" variants={{ hidden: { opacity: 0, y: 18 }, show: { opacity: 1, y: 0 } }}>
          {[
            ['184', 'заявки'],
            ['5.24', 'M ₸'],
            ['33.6', '% оплат'],
          ].map(([value, label]) => (
            <div className="rounded-lg border border-white/10 bg-white/[0.045] p-4" key={label}>
              <AnimatedCounter className="block text-3xl font-black text-[#b7ff3c]" decimals={value.includes('.') ? 1 : 0} value={Number(value)} />
              <p className="mt-1 text-xs font-black text-white/70">{label}</p>
            </div>
          ))}
        </motion.div>
        <motion.h2 className="text-5xl font-black leading-none text-white sm:text-7xl" variants={{ hidden: { opacity: 0, y: 26 }, show: { opacity: 1, y: 0 } }}>
          Пока вы не видите цифры — школа управляет вами
        </motion.h2>
        <motion.p className="mx-auto mt-6 max-w-3xl text-lg font-semibold leading-8 text-white/62" variants={{ hidden: { opacity: 0, y: 18 }, show: { opacity: 1, y: 0 } }}>
          Соберите заявки, учеников, оплаты, расписание и аналитику в одну систему. Начните с бесплатного аудита.
        </motion.p>
        <motion.div className="mt-9 flex flex-col justify-center gap-3 sm:flex-row" variants={{ hidden: { opacity: 0, y: 18 }, show: { opacity: 1, y: 0 } }}>
          <button className="inline-flex justify-center rounded-lg bg-[#b7ff3c] px-6 py-4 text-sm font-black text-black transition hover:bg-white" onClick={() => onOpenForm('audit')} type="button">
            Получить бесплатный аудит
            <ArrowRight className="ml-3 h-5 w-5" />
          </button>
          <button className="rounded-lg border border-white/15 px-6 py-4 text-sm font-black text-white transition hover:border-white hover:bg-white hover:text-black" onClick={() => onOpenForm('demo')} type="button">
            Посмотреть демо
          </button>
          <button className="rounded-lg border border-white/15 px-6 py-4 text-sm font-black text-white transition hover:border-white hover:bg-white hover:text-black" onClick={() => onOpenForm('consultation')} type="button">
            Забронировать консультацию
          </button>
        </motion.div>
      </div>
    </SectionWrapper>
  );
}
