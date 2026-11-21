import { motion } from 'framer-motion';
import { SearchCheck } from 'lucide-react';
import { auditFindings } from '../data/features';
import { SectionWrapper } from './SectionWrapper';

export function AuditFindings() {
  return (
    <SectionWrapper className="bg-[#101114] text-white" dark>
      <div className="mx-auto max-w-4xl text-center">
        <motion.p className="text-xs font-black uppercase tracking-[0.18em] text-[#b7ff3c]" variants={{ hidden: { opacity: 0, y: 18 }, show: { opacity: 1, y: 0 } }}>
          без вымышленных кейсов
        </motion.p>
        <motion.h2 className="mt-4 text-4xl font-black leading-none text-white sm:text-6xl" variants={{ hidden: { opacity: 0, y: 24 }, show: { opacity: 1, y: 0 } }}>
          Что обычно находим на аудите языковой школы
        </motion.h2>
      </div>

      <div className="mt-12 grid gap-4 md:grid-cols-5">
        {auditFindings.map((finding, index) => (
          <motion.article
            className="rounded-xl border border-white/10 bg-white/[0.045] p-5"
            key={finding}
            variants={{ hidden: { opacity: 0, y: 24 }, show: { opacity: 1, y: 0, transition: { delay: index * 0.04 } } }}
            whileHover={{ y: -6, borderColor: 'rgba(183,255,60,.45)' }}
          >
            <SearchCheck className="h-7 w-7 text-[#b7ff3c]" />
            <p className="mt-6 text-lg font-black leading-tight text-white">{finding}</p>
          </motion.article>
        ))}
      </div>
    </SectionWrapper>
  );
}
