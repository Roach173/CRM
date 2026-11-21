import { motion } from 'framer-motion';
import { ArrowRight, Flame, Gauge, Search } from 'lucide-react';
import type { CTAType } from '../data/features';
import { SectionWrapper } from './SectionWrapper';

type WarmupActionsProps = {
  onOpenForm: (type: CTAType) => void;
};

const actions: Array<{
  type: CTAType;
  title: string;
  text: string;
  fit: string;
  button: string;
  intensity: 'soft' | 'medium' | 'hot';
}> = [
  {
    type: 'audit',
    title: 'Бесплатный аудит школы',
    text: 'Покажем, где вы теряете заявки, деньги и контроль. Без продаж в лоб — только разбор вашей текущей системы.',
    fit: 'Если у вас уже есть школа, но процессы держатся на таблицах, чатах и памяти сотрудников.',
    button: 'Получить аудит',
    intensity: 'soft',
  },
  {
    type: 'demo',
    title: 'Демо CRM на реальных сценариях',
    text: 'Покажем, как система ведет заявку, ученика, оплату, расписание и аналитику от начала до конца.',
    fit: 'Если вы хотите увидеть продукт в действии и понять, как он встроится в вашу школу.',
    button: 'Посмотреть демо',
    intensity: 'medium',
  },
  {
    type: 'consultation',
    title: 'Консультация по внедрению',
    text: 'Разберем структуру вашей школы, точки хаоса и предложим схему внедрения CRM под ваши процессы.',
    fit: 'Если вы уже понимаете, что без системы дальше масштабироваться опасно.',
    button: 'Забронировать консультацию',
    intensity: 'hot',
  },
];

const iconMap = {
  audit: Search,
  demo: Gauge,
  consultation: Flame,
};

export function WarmupActions({ onOpenForm }: WarmupActionsProps) {
  return (
    <SectionWrapper className="bg-[#f7f7f1]" id="actions">
      <div className="mx-auto max-w-4xl text-center">
        <motion.p className="text-xs font-black uppercase tracking-[0.18em] text-black/60" variants={{ hidden: { opacity: 0, y: 18 }, show: { opacity: 1, y: 0 } }}>
          три действия
        </motion.p>
        <motion.h2 className="mt-4 text-4xl font-black leading-none text-black sm:text-6xl" variants={{ hidden: { opacity: 0, y: 24 }, show: { opacity: 1, y: 0 } }}>
          Выберите следующий шаг. Даже если вы пока не готовы покупать.
        </motion.h2>
      </div>

      <div className="mt-12 grid gap-4 lg:grid-cols-3">
        {actions.map((action) => {
          const Icon = iconMap[action.type];
          const hot = action.intensity === 'hot';
          const medium = action.intensity === 'medium';

          return (
            <motion.article
              className={`relative overflow-hidden rounded-xl border p-6 transition ${
                hot
                  ? 'landing-animated-border border-black bg-black text-white shadow-[0_34px_110px_rgba(0,0,0,.28)]'
                  : medium
                    ? 'border-black bg-[#151719] text-white shadow-[0_26px_90px_rgba(0,0,0,.18)]'
                    : 'border-black/10 bg-white text-black'
              }`}
              key={action.type}
              variants={{ hidden: { opacity: 0, y: 30 }, show: { opacity: 1, y: 0 } }}
              whileHover={{ y: -8, scale: 1.01 }}
            >
              {hot && <span className="absolute right-4 top-4 rounded-full bg-[#b7ff3c] px-3 py-1 text-[10px] font-black uppercase text-black">Самый быстрый путь</span>}
              <div className={`mb-8 grid h-12 w-12 place-items-center rounded-lg ${hot ? 'bg-[#b7ff3c] text-black' : medium ? 'bg-white/10 text-[#b7ff3c]' : 'bg-black text-[#b7ff3c]'}`}>
                <Icon className="h-6 w-6" />
              </div>
              <h3 className="text-2xl font-black leading-tight">{action.title}</h3>
              <p className={`mt-4 text-sm font-semibold leading-6 ${hot || medium ? 'text-white/64' : 'text-black/62'}`}>{action.text}</p>
              <div className={`mt-6 rounded-lg border p-4 text-sm font-black ${hot || medium ? 'border-white/10 bg-white/[0.055] text-white/78' : 'border-black/10 bg-[#f7f7f1] text-black/70'}`}>
                {action.fit}
              </div>
              <button
                className={`mt-6 inline-flex w-full items-center justify-center rounded-lg px-5 py-4 text-sm font-black transition ${
                  hot ? 'bg-[#b7ff3c] text-black hover:bg-white' : medium ? 'bg-white text-black hover:bg-[#b7ff3c]' : 'bg-black text-white hover:bg-[#b7ff3c] hover:text-black'
                }`}
                onClick={() => onOpenForm(action.type)}
                type="button"
              >
                {action.button}
                <ArrowRight className="ml-3 h-5 w-5" />
              </button>
            </motion.article>
          );
        })}
      </div>
    </SectionWrapper>
  );
}
