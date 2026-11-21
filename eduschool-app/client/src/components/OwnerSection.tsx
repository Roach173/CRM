import { motion } from 'framer-motion';
import { ownerTheses } from '../data/features';
import { DashboardMockup } from './DashboardMockup';
import { SectionWrapper } from './SectionWrapper';

export function OwnerSection() {
  return (
    <SectionWrapper className="bg-white" contentClassName="grid items-center gap-10 lg:grid-cols-[.9fr_1.1fr]" id="owner">
      <div>
        <motion.p className="text-xs font-black uppercase tracking-[0.18em] text-black/60" variants={{ hidden: { opacity: 0, y: 18 }, show: { opacity: 1, y: 0 } }}>
          для владельца
        </motion.p>
        <motion.h2 className="mt-4 text-4xl font-black leading-none text-black sm:text-6xl" variants={{ hidden: { opacity: 0, y: 24 }, show: { opacity: 1, y: 0 } }}>
          Владелец не должен вытаскивать цифры из людей
        </motion.h2>
        <motion.p className="mt-6 max-w-2xl text-lg font-semibold leading-8 text-black/62" variants={{ hidden: { opacity: 0, y: 18 }, show: { opacity: 1, y: 0 } }}>
          Вы должны открывать панель и сразу видеть: сколько пришло заявок, кто их обработал, сколько оплатили, кто должен, какие группы проседают и какие рекламные каналы реально окупаются.
        </motion.p>
        <div className="mt-8 grid gap-3 sm:grid-cols-2">
          {ownerTheses.map((thesis) => (
            <motion.div className="rounded-lg border border-black/10 bg-[#f7f7f1] p-4 text-sm font-black text-black" key={thesis} variants={{ hidden: { opacity: 0, y: 16 }, show: { opacity: 1, y: 0 } }}>
              {thesis}
            </motion.div>
          ))}
        </div>
      </div>

      <DashboardMockup activeStats={['Сегодня', 'Неделя', 'Месяц', 'Источники']} activeTitle="Владелец" variant="owner" />
    </SectionWrapper>
  );
}
