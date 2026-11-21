import { motion, useScroll, useTransform } from 'framer-motion';
import { ArrowRight, Play } from 'lucide-react';
import type { CTAType } from '../data/features';
import { DashboardMockup } from './DashboardMockup';
import { SectionWrapper } from './SectionWrapper';
import { ParallaxWrapper } from './ui/ParallaxWrapper';

type HeroProps = {
  onOpenForm: (type: CTAType) => void;
};

const titleWords = 'CRM для языковых школ, которая показывает, где вы теряете деньги'.split(' ');

export function Hero({ onOpenForm }: HeroProps) {
  const { scrollY } = useScroll();

  // Scroll-linked interactions for absolute premium feel
  const mockupScale = useTransform(scrollY, [0, 600], [1.0, 1.06]);
  const mockupY = useTransform(scrollY, [0, 600], [0, 40]);
  const mockupRotate = useTransform(scrollY, [0, 600], [0, -1.5]);

  // Copy section slightly floats up on scroll
  const copyY = useTransform(scrollY, [0, 600], [0, -35]);

  return (
    <SectionWrapper className="landing-hero bg-[#f7f7f1]" contentClassName="landing-hero-grid grid items-center" id="hero">
      {/* Background with parallax */}
      <ParallaxWrapper speed={0.28} className="absolute inset-0 -z-10">
        <div className="landing-grid absolute inset-0 opacity-70" />
      </ParallaxWrapper>

      <ParallaxWrapper speed={0.4} className="absolute right-[8%] top-[12%] -z-10 h-64 w-64">
        <motion.div
          className="h-full w-full rounded-full bg-[#b7ff3c]/25 blur-[80px]"
          animate={{ scale: [1, 1.18, 1], x: [0, 18, 0] }}
          transition={{ duration: 8, repeat: Infinity }}
        />
      </ParallaxWrapper>

      {/* Copy section */}
      <motion.div style={{ y: copyY }} className="hero-copy min-w-0">
        <motion.p className="hero-eyebrow mb-5 inline-flex rounded-full border border-black/10 bg-white/78 px-4 py-2 text-xs font-black uppercase tracking-[0.14em] text-black/70" variants={{ hidden: { opacity: 0, y: 18 }, show: { opacity: 1, y: 0 } }}>
          цифровой штаб владельца
        </motion.p>
        <h1 className="hero-title max-w-[360px] font-black tracking-normal text-black sm:max-w-3xl">
          {titleWords.map((word, index) => (
            <motion.span
              className="mr-[.22em] inline-block"
              key={`${word}-${index}`}
              variants={{
                hidden: { opacity: 0, y: 34, filter: 'blur(10px)' },
                show: { opacity: 1, y: 0, filter: 'blur(0px)', transition: { delay: index * 0.035, duration: 0.55 } },
              }}
            >
              {word}
            </motion.span>
          ))}
        </h1>
        <motion.p className="hero-subtitle mt-6 max-w-[360px] text-base font-semibold leading-7 text-black/74 sm:max-w-2xl sm:text-lg sm:leading-8" variants={{ hidden: { opacity: 0, y: 20 }, show: { opacity: 1, y: 0 } }}>
          Заявки, ученики, преподаватели, оплаты, расписание и аналитика — в одной системе. Без хаоса в таблицах, Telegram и заметках.
        </motion.p>

        <motion.div className="hero-actions mt-8 flex flex-col gap-3 sm:flex-row" variants={{ hidden: { opacity: 0, y: 20 }, show: { opacity: 1, y: 0 } }}>
          <motion.button
            className="group inline-flex min-h-14 w-full max-w-[340px] items-center justify-center rounded-lg bg-black px-6 py-4 text-sm font-black text-white shadow-[0_24px_70px_rgba(0,0,0,.22)] transition hover:bg-[#b7ff3c] hover:text-black sm:w-auto sm:max-w-none"
            onClick={() => onOpenForm('audit')}
            type="button"
            whileHover={{ scale: 1.025 }}
            whileTap={{ scale: 0.98 }}
          >
            Получить бесплатный аудит
            <ArrowRight className="ml-3 h-5 w-5 transition group-hover:translate-x-1" />
          </motion.button>
          <motion.button
            className="inline-flex min-h-14 w-full max-w-[340px] items-center justify-center rounded-lg border border-black/12 bg-white/70 px-6 py-4 text-sm font-black text-black transition hover:border-black hover:bg-white sm:w-auto sm:max-w-none"
            onClick={() => onOpenForm('demo')}
            type="button"
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
          >
            <Play className="mr-3 h-5 w-5" />
            Посмотреть демо
          </motion.button>
        </motion.div>
        <motion.p className="hero-note mt-4 max-w-[340px] text-sm font-bold leading-6 text-black/66 sm:max-w-none" variants={{ hidden: { opacity: 0 }, show: { opacity: 1, transition: { delay: 0.45 } } }}>
          За 20 минут покажем, где школа теряет заявки, деньги и контроль.
        </motion.p>
      </motion.div>

      {/* Visual mockup section with parallax and active scroll scaling */}
      <motion.div style={{ y: mockupY, scale: mockupScale, rotate: mockupRotate }} className="hero-visual relative hidden min-w-0 md:block">
        <ParallaxWrapper speed={-0.12} className="absolute -left-8 top-16 z-10 hidden xl:block">
          <motion.div
            className="rounded-lg border border-black/10 bg-white/90 p-4 shadow-2xl"
            animate={{ y: [0, -10, 0] }}
            transition={{ duration: 5, repeat: Infinity }}
          >
            <p className="text-xs font-black text-black/62">долги под контролем</p>
            <p className="mt-1 text-2xl font-black text-black">-11%</p>
          </motion.div>
        </ParallaxWrapper>
        <DashboardMockup className="hero-dashboard ml-auto max-w-[clamp(460px,43vw,650px)]" />
      </motion.div>
    </SectionWrapper>
  );
}
