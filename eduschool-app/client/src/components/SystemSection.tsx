import { motion, useMotionValueEvent, useScroll, useTransform } from 'framer-motion';
import {
  BarChart3,
  CalendarClock,
  ClipboardCheck,
  CreditCard,
  FileText,
  Filter,
  GraduationCap,
  History,
  LineChart,
  MessageSquareText,
  Sparkles,
  TrendingUp,
  UserRoundCog,
  UsersRound,
  WalletCards,
  type LucideIcon,
} from 'lucide-react';
import { useRef, useState } from 'react';
import systemFinance from '../assets/landing/system-finance.png';
import systemSales from '../assets/landing/system-sales.png';
import systemStudents from '../assets/landing/system-students.png';
import systemTeachers from '../assets/landing/system-teachers.png';
import { systemTabs } from '../data/features';
import { SectionWrapper } from './SectionWrapper';

const systemImages = [systemSales, systemStudents, systemTeachers, systemFinance];

const systemStepDetails: {
  intro: string;
  result: string;
  cards: { description: string; icon: LucideIcon }[];
}[] = [
  {
    intro: 'Контролируйте каждый этап: от заявки до оплаты. Система подскажет, где вы теряете клиентов.',
    result: 'больше сделок, выше конверсия, рост выручки',
    cards: [
      { icon: MessageSquareText, description: 'Заявки с сайта и мессенджеров в одном окне' },
      { icon: UserRoundCog, description: 'Задачи администраторам и контроль исполнения' },
      { icon: History, description: 'История общения и касаний всегда под рукой' },
      { icon: Filter, description: 'Понятная конверсия по каждому источнику' },
    ],
  },
  {
    intro: 'Каждый ученик виден полностью: обучение, оплаты, посещения и прогресс не расходятся по чатам.',
    result: 'меньше оттока, ясный прогресс, контроль каждого ученика',
    cards: [
      { icon: GraduationCap, description: 'Контакты, группа и статус в одной карточке' },
      { icon: TrendingUp, description: 'Прогресс ученика и следующий шаг обучения' },
      { icon: CalendarClock, description: 'Посещаемость, пропуски и риски оттока' },
      { icon: FileText, description: 'Оплаты, задания и история обучения вместе' },
    ],
  },
  {
    intro: 'Управляйте нагрузкой преподавателей, заменами и качеством занятий без ручной сверки.',
    result: 'стабильное расписание, прозрачная нагрузка, понятное качество',
    cards: [
      { icon: CalendarClock, description: 'Уроки, кабинеты и замены в календаре' },
      { icon: UsersRound, description: 'Нагрузка преподавателей и свободные окна' },
      { icon: ClipboardCheck, description: 'Итоги занятий сразу после урока' },
      { icon: BarChart3, description: 'Загрузка и качество по каждому педагогу' },
    ],
  },
  {
    intro: 'Деньги, долги, реклама и прогнозы находятся в одной финансовой картине школы.',
    result: 'меньше долгов, понятная реклама, прогнозируемая выручка',
    cards: [
      { icon: WalletCards, description: 'Оплаты и просрочки в реальном времени' },
      { icon: LineChart, description: 'LTV, CAC и доходность каждого ученика' },
      { icon: BarChart3, description: 'Окупаемость рекламы по всем каналам' },
      { icon: CreditCard, description: 'Прогноз оплат и будущих поступлений' },
    ],
  },
];

export function SystemSection() {
  const [active, setActive] = useState(0);
  const timelineRef = useRef<HTMLDivElement>(null);

  const { scrollYProgress } = useScroll({
    target: timelineRef,
    offset: ['start center', 'end center'],
  });
  const lineProgress = useTransform(scrollYProgress, [0, 1], [0, 1]);

  useMotionValueEvent(scrollYProgress, 'change', (latest) => {
    const numTabs = systemTabs.length;
    const band = 1 / numTabs;
    let newActive = Math.floor(latest / band);

    if (newActive < 0) newActive = 0;
    if (newActive >= numTabs) newActive = numTabs - 1;

    setActive((currentActive) => (newActive === currentActive ? currentActive : newActive));
  });

  return (
    <SectionWrapper
      className="bg-[#f7f7f1]"
      contentClassName="relative w-full"
      id="features"
    >
      <div className="relative w-full">
        <div className="mx-auto mb-16 max-w-4xl text-center">
          <motion.p
            className="text-xs font-black uppercase tracking-[0.18em] text-black/60"
            variants={{ hidden: { opacity: 0, y: 18 }, show: { opacity: 1, y: 0 } }}
          >
            новая система управления
          </motion.p>
          <motion.h2
            className="mx-auto mt-4 max-w-4xl text-4xl font-black leading-none text-black sm:text-6xl"
            variants={{ hidden: { opacity: 0, y: 26 }, show: { opacity: 1, y: 0 } }}
          >
            Школа должна работать как система. Даже когда вас нет.
          </motion.h2>
          <motion.p
            className="mx-auto mt-6 max-w-2xl text-lg font-semibold leading-8 text-black/62"
            variants={{ hidden: { opacity: 0, y: 18 }, show: { opacity: 1, y: 0 } }}
          >
            CRM собирает все процессы в один центр управления: от первой заявки до продления абонемента.
          </motion.p>
        </div>

        <div className="relative mt-20" ref={timelineRef}>
          <div className="absolute bottom-0 left-[18px] top-0 w-px bg-black/10 lg:left-1/2 lg:-translate-x-1/2" />
          <motion.div
            aria-hidden="true"
            className="absolute bottom-0 left-[17px] top-0 w-[3px] origin-top rounded-full bg-[#b7ff3c] shadow-[0_0_28px_rgba(183,255,60,.48)] lg:left-1/2 lg:-translate-x-1/2"
            style={{ scaleY: lineProgress }}
          />

          <div className="relative grid gap-16 lg:gap-0">
            {systemTabs.map((tab, index) => {
              const imageOnLeft = index % 2 === 1;
              const isPassed = active >= index;
              const isCurrent = active === index;
              const detail = systemStepDetails[index];
              const textBlock = (
                <motion.article
                  className={`max-w-[38rem] transition duration-500 ${
                    isCurrent ? 'opacity-100' : 'opacity-55'
                  }`}
                  variants={{ hidden: { opacity: 0, y: 18 }, show: { opacity: 1, y: 0 } }}
                >
                  <span className="inline-block rounded-full bg-lime-100 px-5 py-2 text-xs font-black uppercase tracking-[0.08em] text-lime-700">
                    {tab.title}
                  </span>
                  <h3 className="mt-4 text-3xl font-black leading-tight text-black sm:text-4xl">
                    {tab.label}
                  </h3>
                  <p className="mt-4 max-w-[34rem] text-base font-medium leading-7 text-black/62">
                    {detail.intro}
                  </p>
                  <div className="mt-6 grid gap-3 sm:grid-cols-2">
                    {tab.bullets.map((bullet, bulletIndex) => {
                      const Icon = detail.cards[bulletIndex].icon;

                      return (
                      <div
                        className="grid h-[6.75rem] grid-cols-[2.75rem_1fr] gap-3 rounded-lg border border-black/8 bg-white px-4 py-4 text-left shadow-[0_14px_45px_rgba(0,0,0,.07)]"
                        key={bullet}
                      >
                        <span className="grid h-11 w-11 place-items-center rounded-lg bg-lime-100 text-lime-700">
                          <Icon className="h-5 w-5" />
                        </span>
                        <span>
                          <span className="block text-[0.82rem] font-black leading-snug text-black">{bullet}</span>
                          <span className="mt-2 block text-[0.78rem] font-medium leading-[1.25rem] text-black/58">
                            {detail.cards[bulletIndex].description}
                          </span>
                        </span>
                      </div>
                      );
                    })}
                  </div>
                  <div className="mt-5 flex items-start gap-3 rounded-lg border border-lime-300/35 bg-lime-50/45 px-5 py-4 text-sm font-semibold text-black/58">
                    <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-lime-700/80" />
                    <p>
                      <span className="font-black text-lime-700/85">Результат: </span>
                      {detail.result}
                    </p>
                  </div>
                </motion.article>
              );
              const imageBlock = (
                <motion.div
                  className={`relative overflow-hidden rounded-lg border border-black/10 bg-white shadow-[0_28px_90px_rgba(0,0,0,.14)] transition duration-500 ${
                    isCurrent ? 'opacity-100 saturate-100' : 'opacity-55 saturate-[.7]'
                  }`}
                  variants={{ hidden: { opacity: 0, y: 22 }, show: { opacity: 1, y: 0 } }}
                >
                  <img
                    alt={`${tab.title}: ${tab.label}`}
                    className="aspect-[16/10] h-full w-full object-cover object-top"
                    loading="lazy"
                    src={systemImages[index]}
                  />
                </motion.div>
              );

              return (
                <div
                  className="relative grid gap-5 pl-14 lg:min-h-[min(78vh,680px)] lg:grid-cols-[minmax(0,1fr)_96px_minmax(0,1fr)] lg:items-center lg:gap-0 lg:pl-0"
                  key={tab.title}
                >
                  <div className="absolute left-0 top-2 z-10 grid h-9 w-9 place-items-center lg:static lg:col-start-2 lg:row-start-1 lg:mx-auto">
                    <span
                      className={`grid h-9 w-9 place-items-center rounded-full border text-[0.68rem] font-black transition duration-500 ${
                        isPassed
                          ? 'border-black bg-black text-[#b7ff3c] shadow-[0_12px_40px_rgba(0,0,0,.16)]'
                          : 'border-black/15 bg-[#f7f7f1] text-black/38'
                      } ${isCurrent ? 'scale-110' : 'scale-100'}`}
                    >
                      {String(index + 1).padStart(2, '0')}
                    </span>
                  </div>

                  {imageOnLeft ? (
                    <>
                      <div className="order-2 lg:order-none lg:col-start-1 lg:row-start-1 lg:pr-10">
                        {imageBlock}
                      </div>
                      <div className="order-1 lg:order-none lg:col-start-3 lg:row-start-1 lg:pl-10">
                        {textBlock}
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="order-1 lg:order-none lg:col-start-1 lg:row-start-1 lg:pr-10">
                        {textBlock}
                      </div>
                      <div className="order-2 lg:order-none lg:col-start-3 lg:row-start-1 lg:pl-10">
                        {imageBlock}
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </SectionWrapper>
  );
}
