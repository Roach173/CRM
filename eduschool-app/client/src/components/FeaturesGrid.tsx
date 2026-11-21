import { motion } from 'framer-motion';
import { featureItems } from '../data/features';
import { SectionWrapper } from './SectionWrapper';

export function FeaturesGrid() {
  return (
    <SectionWrapper className="bg-[#f7f7f1]" id="features">
      <div className="mx-auto max-w-4xl text-center">
        <motion.p className="text-xs font-black uppercase tracking-[0.18em] text-black/60" variants={{ hidden: { opacity: 0, y: 18 }, show: { opacity: 1, y: 0 } }}>
          возможности
        </motion.p>
        <motion.h2 className="mt-4 text-4xl font-black leading-none text-black sm:text-6xl" variants={{ hidden: { opacity: 0, y: 24 }, show: { opacity: 1, y: 0 } }}>
          Все, что нужно языковой школе — в одной системе
        </motion.h2>
      </div>

      <div className="mt-12 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {featureItems.map((item) => {
          const Icon = item.icon;
          return (
            <motion.div
              className="group min-h-32 rounded-lg border border-black/10 bg-white p-4 shadow-[0_12px_36px_rgba(0,0,0,.04)] transition hover:border-black hover:bg-black hover:text-white"
              key={item.title}
              variants={{ hidden: { opacity: 0, y: 18 }, show: { opacity: 1, y: 0 } }}
              whileHover={{ y: -5 }}
            >
              <Icon className="h-6 w-6 text-black group-hover:text-[#b7ff3c]" />
              <p className="mt-5 text-sm font-black leading-tight">{item.title}</p>
            </motion.div>
          );
        })}
      </div>
    </SectionWrapper>
  );
}
