import { motion } from 'framer-motion';
import { ArrowRight, Check, X } from 'lucide-react';
import { comparisonRows, type CTAType } from '../data/features';
import { SectionWrapper } from './SectionWrapper';

type ComparisonSectionProps = {
  onOpenForm: (type: CTAType) => void;
};

export function ComparisonSection({ onOpenForm }: ComparisonSectionProps) {
  return (
    <SectionWrapper className="bg-white" contentClassName="grid items-center gap-10 lg:grid-cols-[.82fr_1.18fr]">
      <div>
        <motion.h2 className="text-4xl font-black leading-none text-black sm:text-6xl" variants={{ hidden: { opacity: 0, y: 24 }, show: { opacity: 1, y: 0 } }}>
          Excel не управляет школой. Он просто хранит последствия хаоса.
        </motion.h2>
        <motion.p className="mt-6 max-w-2xl text-lg font-semibold leading-8 text-black/62" variants={{ hidden: { opacity: 0, y: 18 }, show: { opacity: 1, y: 0 } }}>
          Таблицы не напоминают администратору дожать заявку. Не показывают реальную конверсию. Не связывают рекламу с оплатами. Не контролируют долги.
        </motion.p>
        <motion.div variants={{ hidden: { opacity: 0, y: 18 }, show: { opacity: 1, y: 0 } }}>
          <p className="mt-8 text-2xl font-black text-black">Хватит управлять школой через костыли</p>
          <button className="mt-5 inline-flex rounded-lg bg-black px-6 py-4 text-sm font-black text-white transition hover:bg-[#b7ff3c] hover:text-black" onClick={() => onOpenForm('demo')} type="button">
            Посмотреть, как работает CRM
            <ArrowRight className="ml-3 h-5 w-5" />
          </button>
        </motion.div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <motion.div className="rounded-xl border border-black/10 bg-[#f7f7f1] p-6" variants={{ hidden: { opacity: 0, x: -22 }, show: { opacity: 1, x: 0 } }}>
          <h3 className="text-2xl font-black text-black">Таблицы</h3>
          <div className="mt-6 space-y-3">
            {comparisonRows.sheets.map((row) => (
              <div className="flex items-center gap-3 rounded-lg bg-white p-4 text-sm font-black text-black/68" key={row}>
                <X className="h-5 w-5 text-red-500" />
                {row}
              </div>
            ))}
          </div>
        </motion.div>
        <motion.div className="rounded-xl border border-black bg-black p-6 text-white shadow-[0_30px_100px_rgba(0,0,0,.25)]" variants={{ hidden: { opacity: 0, x: 22 }, show: { opacity: 1, x: 0 } }}>
          <h3 className="text-2xl font-black text-white">CRM</h3>
          <div className="mt-6 space-y-3">
            {comparisonRows.crm.map((row) => (
              <div className="flex items-center gap-3 rounded-lg bg-white/[0.07] p-4 text-sm font-black text-white" key={row}>
                <Check className="h-5 w-5 text-[#b7ff3c]" />
                {row}
              </div>
            ))}
          </div>
        </motion.div>
      </div>
    </SectionWrapper>
  );
}
