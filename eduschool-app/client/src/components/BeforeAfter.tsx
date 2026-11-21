import { motion, useScroll, useTransform } from 'framer-motion';
import { Check, X } from 'lucide-react';
import { useRef } from 'react';
import { SectionWrapper } from './SectionWrapper';

const before = ['заявки в Telegram', 'оплаты в Excel', 'расписание в Google Sheets', 'админы работают без контроля', 'отчеты собираются вручную', 'владелец узнает о проблемах поздно'];
const after = ['все заявки в CRM', 'оплаты и долги видны сразу', 'расписание синхронизировано', 'админы работают по задачам', 'отчеты строятся автоматически', 'владелец видит бизнес в цифрах каждый день'];

export function BeforeAfter() {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start end', 'end start'] });
  const beforeScale = useTransform(scrollYProgress, [0.15, 0.7], [1, 0.98]);
  const afterScale = useTransform(scrollYProgress, [0.15, 0.7], [0.99, 1.01]);
  const beforeOpacity = useTransform(scrollYProgress, [0.15, 0.7], [1, 0.76]);

  return (
    <SectionWrapper className="bg-[#101114] text-white" dark>
      <div className="mx-auto max-w-4xl text-center">
        <motion.h2 className="text-4xl font-black leading-none text-white sm:text-6xl" variants={{ hidden: { opacity: 0, y: 24 }, show: { opacity: 1, y: 0 } }}>
          До CRM — вы тушите пожары. После CRM — управляете системой.
        </motion.h2>
      </div>

      <div className="mt-12 grid gap-4 lg:grid-cols-[1fr_80px_1fr]" ref={ref}>
        <motion.div className="rounded-xl border border-white/10 bg-white/[0.045] p-6" style={{ opacity: beforeOpacity, scale: beforeScale }}>
          <p className="mb-6 text-xs font-black uppercase tracking-[0.18em] text-red-300">До</p>
          <div className="space-y-3">
            {before.map((item) => (
              <div className="flex items-center gap-3 rounded-lg bg-black/20 p-4 text-sm font-black text-white/74" key={item}>
                <X className="h-5 w-5 text-red-300" />
                {item}
              </div>
            ))}
          </div>
        </motion.div>

        <div className="hidden items-center justify-center lg:flex">
          <div className="h-full w-px bg-gradient-to-b from-transparent via-[#b7ff3c] to-transparent" />
        </div>

        <motion.div className="rounded-xl border border-[#b7ff3c]/40 bg-[#b7ff3c] p-6 text-black shadow-[0_0_90px_rgba(183,255,60,.2)]" style={{ scale: afterScale }}>
          <p className="mb-6 text-xs font-black uppercase tracking-[0.18em] text-black/55">После</p>
          <div className="space-y-3">
            {after.map((item) => (
              <div className="flex items-center gap-3 rounded-lg bg-black/90 p-4 text-sm font-black text-white" key={item}>
                <Check className="h-5 w-5 text-[#b7ff3c]" />
                {item}
              </div>
            ))}
          </div>
        </motion.div>
      </div>
    </SectionWrapper>
  );
}
