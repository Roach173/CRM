import { useEffect, useState, type ReactNode } from 'react';
import { useParams, Link } from 'react-router';
import { Spinner } from '../components/ui/Spinner';
import { CheckCircle, XCircle, Star, ChevronDown, Mail, CreditCard, Landmark, GraduationCap } from 'lucide-react';
import api, { resolveUploadUrl } from '../lib/api';
import { type PixelSettings, usePixelLoader } from '../lib/pixels';
import { useScrollReveal } from '../hooks/useScrollReveal';
import { useParallax } from '../hooks/useParallax';

interface SchoolData {
  name: string;
  city?: string | null;
  phone?: string | null;
  email?: string | null;
  slug: string;
  logoUrl?: string | null;
  description?: string | null;
  createdAt?: string;
  studentCount?: number;
  teacherCount?: number;
  landingConfig?: { heroImageUrl?: string | null } | null;
  pixels?: PixelSettings | null;
}

function initials(name: string) {
  return name.split(' ').filter(Boolean).map((p) => p[0]).join('').slice(0, 2).toUpperCase();
}

// Reveal-on-scroll wrapper — native IntersectionObserver (see useScrollReveal),
// reuses the fade-in/slide-up keyframes already defined in tailwind.config.ts.
function Reveal({
  children,
  className = '',
  delay = 0,
  variant = 'fade',
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  variant?: 'fade' | 'slide';
}) {
  const { ref, isVisible } = useScrollReveal<HTMLDivElement>();
  const animationClass = variant === 'slide' ? 'animate-slide-up' : 'animate-fade-in';
  return (
    <div
      ref={ref}
      className={`${className} ${isVisible ? animationClass : 'opacity-0'}`}
      style={{ animationDuration: variant === 'slide' ? '600ms' : '700ms', animationDelay: `${delay}ms`, animationFillMode: 'both' }}
    >
      {children}
    </div>
  );
}

const GENERIC_HERO_COPY = 'Окунитесь в атмосферу академического спокойствия. Мы объединяем классические методики с современным подходом к обучению.';

export default function SchoolLanding() {
  const { slug } = useParams<{ slug: string }>();
  const [school, setSchool] = useState<SchoolData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(false);

  // TODO: emit lead_submitted conversion events after consent and event mapping are defined.
  usePixelLoader(school?.pixels);

  useEffect(() => {
    async function fetchSchool() {
      try {
        const res = await api.get(`/schools/${slug}`);
        if (res.data.success) {
          const data = res.data.data as SchoolData;
          setSchool(data);
        } else {
          setError(true);
        }
      } catch {
        setError(true);
      } finally {
        setIsLoading(false);
      }
    }
    if (slug) fetchSchool();
  }, [slug]); // eslint-disable-line react-hooks/exhaustive-deps

  if (isLoading) {
    return (
      <div className="min-h-screen flex justify-center items-center bg-background">
        <Spinner />
      </div>
    );
  }

  if (error || !school) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-background p-4 text-center">
        <div className="text-5xl mb-2">🏫</div>
        <h1 className="text-3xl font-serif text-danger font-bold">Школа не найдена</h1>
        <p className="text-textSecondary">Проверьте ссылку или обратитесь к администратору.</p>
        <Link to="/" className="text-primary mt-4 font-medium hover:underline inline-flex items-center">
          ← На главную платформу
        </Link>
      </div>
    );
  }

  return <SchoolLandingView school={school} slug={slug!} />;
}

// Only mounted once school data has loaded — useScrollReveal/useParallax below
// attach their IntersectionObserver/scroll-listener in an effect that runs
// once per mount, so the ref they observe must already point at a real DOM
// node on that same mount. Calling those hooks directly in SchoolLanding
// (which renders a Spinner-only tree while loading) would attach the ref to
// nothing on their one effect run and never re-fire once data arrived.
function SchoolLandingView({ school, slug }: { school: SchoolData; slug: string }) {
  const heroRef = useScrollReveal<HTMLDivElement>();
  const heroImageParallaxRef = useParallax<HTMLDivElement>(0.08);

  const heroImageUrl = resolveUploadUrl(school.landingConfig?.heroImageUrl);
  const logoUrl = resolveUploadUrl(school.logoUrl);
  const foundedYear = school.createdAt ? new Date(school.createdAt).getFullYear() : null;

  return (
    <div className="bg-background text-surface font-sans selection:bg-primaryContainer selection:text-onPrimaryContainer min-h-screen flex flex-col">
      {/* TopNavBar */}
      <nav className="bg-[#f8faf8]/95 backdrop-blur-md sticky top-0 z-50 flex justify-between items-center w-full px-6 py-4 border-b border-border shadow-sm">
        <div className="flex items-center gap-3">
          {logoUrl && <img src={logoUrl} alt="" className="h-9 w-9 rounded-lg object-cover" />}
          <span className="font-serif text-2xl font-bold text-primary">{school.name}</span>
        </div>
        <div className="flex items-center gap-4">
          <Link to={`/${slug}/login`}>
            <button className="bg-primary text-white px-6 py-2 rounded-lg font-medium text-sm transition-transform active:scale-95 hover:opacity-90 shadow-sm">
              Начать обучение
            </button>
          </Link>
        </div>
      </nav>

      <main className="flex-1">
        {/* Hero Section */}
        <section className="relative pt-20 pb-20 md:pb-32 px-6 overflow-hidden max-w-7xl mx-auto">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 items-center">
            <div ref={heroRef.ref} className={heroRef.isVisible ? 'animate-fade-in' : 'opacity-0'} style={{ animationDuration: '700ms', animationFillMode: 'both' }}>
              <span className="text-xs uppercase tracking-widest text-primary font-bold mb-6 block">
                {school.city ? `г. ${school.city}` : 'Образовательный центр'}
              </span>
              <h1 className="font-serif text-4xl md:text-6xl leading-[1.2] text-surface mb-8 font-bold">
                Искусство мыслить на новом языке.
              </h1>
              <p className="text-textSecondary text-lg max-w-lg mb-12">
                {school.description?.trim() || GENERIC_HERO_COPY}
              </p>

              <div className="flex gap-4 mb-16">
                <Link to={`/${slug}/login`}>
                  <button className="bg-primary text-white px-8 py-4 rounded-xl font-semibold shadow-lg hover:opacity-90 transition">
                    Начать обучение
                  </button>
                </Link>
              </div>

              {/* Statistics — real per-school numbers, not a generic template */}
              <div className="grid grid-cols-3 gap-8 border-t border-border pt-10">
                <div>
                  <div className="text-3xl font-serif text-primary font-bold">{school.studentCount ?? 0}</div>
                  <div className="text-xs text-textSecondary uppercase tracking-widest mt-1 font-semibold">Студентов</div>
                </div>
                <div>
                  <div className="text-3xl font-serif text-primary font-bold">{school.teacherCount ?? 0}</div>
                  <div className="text-xs text-textSecondary uppercase tracking-widest mt-1 font-semibold">Преподавателей</div>
                </div>
                <div>
                  <div className="text-3xl font-serif text-primary font-bold">{foundedYear ?? '—'}</div>
                  <div className="text-xs text-textSecondary uppercase tracking-widest mt-1 font-semibold">С какого года</div>
                </div>
              </div>
            </div>

            <div className="relative hidden lg:block">
              {heroImageUrl ? (
                <div ref={heroImageParallaxRef} className="aspect-[4/5] rounded-[2rem] overflow-hidden shadow-2xl relative z-10 border border-border">
                  <img className="w-full h-full object-cover" alt={school.name} src={heroImageUrl} />
                </div>
              ) : (
                <div className="aspect-[4/5] rounded-[2rem] overflow-hidden shadow-2xl relative z-10 border border-border bg-gradient-to-br from-primaryContainer/40 to-primary/10 flex items-center justify-center">
                  <GraduationCap className="w-24 h-24 text-primary/40" />
                </div>
              )}
              <div className="absolute -top-10 -right-10 w-64 h-64 bg-primaryContainer/40 rounded-full blur-3xl -z-0"></div>
              <div className="absolute -bottom-10 -left-10 w-80 h-80 bg-primary/20 rounded-full blur-3xl -z-0"></div>
            </div>
          </div>
        </section>

        {/* Levels Section (Bento Grid) */}
        <section className="py-24 bg-surfaceLow px-6">
          <div className="max-w-7xl mx-auto">
            <Reveal className="flex justify-between items-end mb-16">
              <div className="max-w-2xl">
                <h2 className="font-serif text-3xl font-bold text-surface mb-4">Уровни владения языком</h2>
                <p className="text-textSecondary">Мы следуем стандартам CEFR, обеспечивая четкий прогресс от основ до свободного общения.</p>
              </div>
            </Reveal>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <Reveal delay={0} className="bg-surfaceLowest p-8 rounded-2xl flex flex-col justify-between min-h-[300px] transition-transform hover:-translate-y-1 shadow-sm border border-border">
                <div>
                  <span className="rounded-tl-xl rounded-br-xl bg-primaryContainer text-onPrimaryContainer px-3 py-1 text-xs font-bold mb-6 inline-block">Elementary</span>
                  <h3 className="font-serif text-2xl mb-4 font-bold">A1 — A2</h3>
                  <p className="text-textSecondary text-sm">Закладываем фундамент: базовая грамматика, лексика для повседневных ситуаций и уверенное начало диалога.</p>
                </div>
                <div className="h-2 w-full bg-surfaceLow rounded-full overflow-hidden mt-8">
                  <div className="h-full bg-primary w-1/3"></div>
                </div>
              </Reveal>

              <Reveal delay={100} className="bg-primary p-8 rounded-2xl flex flex-col justify-between min-h-[300px] text-white transition-transform hover:-translate-y-1 shadow-lg">
                <div>
                  <span style={{ backgroundColor: 'rgba(255,255,255,0.2)' }} className="rounded-tl-xl rounded-br-xl px-3 py-1 text-xs font-bold mb-6 inline-block">Intermediate</span>
                  <h3 className="font-serif text-2xl mb-4 font-bold text-white">B1 — B2</h3>
                  <p className="text-white/80 text-sm">Свобода выражения: обсуждение сложных тем, чтение литературы и уверенное понимание носителей языка.</p>
                </div>
                <div className="h-2 w-full bg-white/20 rounded-full overflow-hidden mt-8">
                  <div className="h-full bg-primaryContainer w-2/3"></div>
                </div>
              </Reveal>

              <Reveal delay={200} className="bg-surfaceLowest p-8 rounded-2xl flex flex-col justify-between min-h-[300px] transition-transform hover:-translate-y-1 shadow-sm border border-border">
                <div>
                  <span className="rounded-tl-xl rounded-br-xl bg-primary/10 text-primary px-3 py-1 text-xs font-bold mb-6 inline-block">Advanced</span>
                  <h3 className="font-serif text-2xl mb-4 font-bold">C1</h3>
                  <p className="text-textSecondary text-sm">Мастерство: нюансы языка, идиомы, профессиональная лексика и полная академическая свобода.</p>
                </div>
                <div className="h-2 w-full bg-surfaceLow rounded-full overflow-hidden mt-8">
                  <div className="h-full bg-primary w-full"></div>
                </div>
              </Reveal>
            </div>
          </div>
        </section>

        {/* Pricing Grid — tiers only, no fabricated universal prices (every school sets its own) */}
        <section className="py-24 px-6 border-t border-border bg-background">
          <div className="max-w-7xl mx-auto">
            <Reveal className="text-center mb-16">
              <h2 className="font-serif text-3xl font-bold text-surface mb-4">Выберите свой путь</h2>
              <p className="text-textSecondary">Подберём формат обучения под ваши цели и график</p>
            </Reveal>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-8 items-center">
              <Reveal delay={0} className="bg-surfaceLow p-10 rounded-2xl relative overflow-hidden border border-border">
                <div className="mb-8">
                  <div className="text-xs font-sans text-primary uppercase tracking-widest mb-2 font-bold">Групповой</div>
                  <div className="text-2xl font-serif font-bold text-surface">Стоимость по запросу</div>
                </div>
                <ul className="space-y-4">
                  <li className="flex items-center gap-3 text-sm"><CheckCircle className="text-primary w-5 h-5" /> 2 занятия в неделю</li>
                  <li className="flex items-center gap-3 text-sm"><CheckCircle className="text-primary w-5 h-5" /> Группы до 6 человек</li>
                  <li className="flex items-center gap-3 text-sm"><CheckCircle className="text-primary w-5 h-5" /> Доступ к библиотеке</li>
                  <li className="flex items-center gap-3 text-sm opacity-50"><XCircle className="w-5 h-5 text-textSecondary" /> Персональный куратор</li>
                </ul>
              </Reveal>

              <Reveal delay={100} variant="slide" className="bg-surfaceLowest p-10 rounded-2xl shadow-xl relative overflow-hidden border-2 border-primary transform md:scale-105 z-10">
                <div className="absolute top-4 right-4">
                  <span className="rounded-tl-xl rounded-br-xl bg-primary text-white text-[10px] px-3 py-1 uppercase tracking-widest font-bold">Популярный</span>
                </div>
                <div className="mb-8">
                  <div className="text-xs font-sans text-primary uppercase tracking-widest mb-2 font-bold">Интенсив</div>
                  <div className="text-2xl font-serif font-bold text-surface">Стоимость по запросу</div>
                </div>
                <ul className="space-y-4">
                  <li className="flex items-center gap-3 text-sm"><CheckCircle className="text-primary w-5 h-5" /> 3 занятия в неделю</li>
                  <li className="flex items-center gap-3 text-sm"><CheckCircle className="text-primary w-5 h-5" /> Группы до 4 человек</li>
                  <li className="flex items-center gap-3 text-sm"><CheckCircle className="text-primary w-5 h-5" /> Разговорный клуб</li>
                  <li className="flex items-center gap-3 text-sm"><CheckCircle className="text-primary w-5 h-5" /> Подготовка к экзаменам</li>
                </ul>
              </Reveal>

              <Reveal delay={200} className="bg-surfaceLow p-10 rounded-2xl border border-border">
                <div className="mb-8">
                  <div className="text-xs font-sans text-primary uppercase tracking-widest mb-2 font-bold">Индивидуальный</div>
                  <div className="text-2xl font-serif font-bold text-surface">Стоимость по запросу</div>
                </div>
                <ul className="space-y-4">
                  <li className="flex items-center gap-3 text-sm"><CheckCircle className="text-primary w-5 h-5" /> Гибкий график</li>
                  <li className="flex items-center gap-3 text-sm"><CheckCircle className="text-primary w-5 h-5" /> 1 на 1 с учителем</li>
                  <li className="flex items-center gap-3 text-sm"><CheckCircle className="text-primary w-5 h-5" /> Личная программа</li>
                  <li className="flex items-center gap-3 text-sm"><CheckCircle className="text-primary w-5 h-5" /> VIP поддержка 24/7</li>
                </ul>
              </Reveal>
            </div>

            <div className="flex justify-center mt-12">
              <Link to={`/${slug}/login`}>
                <button className="bg-primary text-white px-10 py-4 rounded-xl font-semibold shadow-lg hover:opacity-90 transition">
                  Узнать стоимость
                </button>
              </Link>
            </div>
          </div>
        </section>

        {/* Testimonials */}
        <section className="py-24 bg-primary text-white px-6 relative overflow-hidden">
          <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-12 items-center">
            <Reveal className="lg:col-span-4">
              <h2 className="font-serif text-4xl md:text-5xl font-bold leading-tight mb-6 italic">Что говорят наши студенты</h2>
              <p className="opacity-80 text-lg">История успеха каждого ученика — это наша главная гордость и вдохновение.</p>
            </Reveal>

            <div className="lg:col-span-8 grid grid-cols-1 md:grid-cols-2 gap-6">
              <Reveal delay={0} className="bg-primary-dark bg-opacity-30 p-8 rounded-2xl lg:mt-12 border border-white/10">
                <div className="flex gap-1 mb-4 text-warning">
                  {Array.from({ length: 5 }).map((_, i) => <Star key={i} fill="currentColor" size={20} />)}
                </div>
                <p className="mb-8 text-lg font-medium italic leading-relaxed">«Атмосфера школы {school.name} просто потрясающая. Это не просто уроки, а настоящее погружение в культуру.»</p>
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-full bg-white/20 flex items-center justify-center font-bold text-sm">{initials('Алексей М.')}</div>
                  <div>
                    <div className="font-bold">Алексей М.</div>
                    <div className="text-xs opacity-70">Уровень B2, Маркетолог</div>
                  </div>
                </div>
              </Reveal>

              <Reveal delay={100} className="bg-primary-dark bg-opacity-30 p-8 rounded-2xl border border-white/10">
                <div className="flex gap-1 mb-4 text-warning">
                  {Array.from({ length: 5 }).map((_, i) => <Star key={i} fill="currentColor" size={20} />)}
                </div>
                <p className="mb-8 text-lg font-medium italic leading-relaxed">«За 3 месяца я преодолела языковой барьер, который мучил меня годами. Спасибо педагогам за терпение!»</p>
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-full bg-white/20 flex items-center justify-center font-bold text-sm">{initials('Мария С.')}</div>
                  <div>
                    <div className="font-bold">Мария С.</div>
                    <div className="text-xs opacity-70">Уровень A2, Студентка</div>
                  </div>
                </div>
              </Reveal>
            </div>
          </div>
        </section>

        {/* FAQ Section */}
        <section className="py-24 px-6 bg-background">
          <div className="max-w-3xl mx-auto">
            <h2 className="font-serif text-3xl font-bold text-surface mb-12 text-center">Часто задаваемые вопросы</h2>
            <div className="space-y-4">
              <Reveal delay={0}>
                <details className="group bg-surfaceLow rounded-2xl border border-border">
                  <summary className="flex justify-between items-center p-6 cursor-pointer list-none">
                    <span className="font-bold text-surface">Как проходят занятия?</span>
                    <ChevronDown className="transition-transform group-open:rotate-180 text-primary w-5 h-5" />
                  </summary>
                  <div className="px-6 pb-6 text-textSecondary text-sm leading-relaxed">
                    Мы используем коммуникативную методику. 70% времени занятия отводится разговорной практике. Уроки проходят на нашей интерактивной платформе с использованием медиа-материалов.
                  </div>
                </details>
              </Reveal>
              <Reveal delay={80}>
                <details className="group bg-surfaceLow rounded-2xl border border-border">
                  <summary className="flex justify-between items-center p-6 cursor-pointer list-none">
                    <span className="font-bold text-surface">Нужно ли покупать учебники?</span>
                    <ChevronDown className="transition-transform group-open:rotate-180 text-primary w-5 h-5" />
                  </summary>
                  <div className="px-6 pb-6 text-textSecondary text-sm leading-relaxed">
                    Нет, все необходимые учебные материалы уже включены в стоимость обучения и доступны в вашем личном кабинете в цифровом виде.
                  </div>
                </details>
              </Reveal>
              <Reveal delay={160}>
                <details className="group bg-surfaceLow rounded-2xl border border-border">
                  <summary className="flex justify-between items-center p-6 cursor-pointer list-none">
                    <span className="font-bold text-surface">Можно ли перенести занятие?</span>
                    <ChevronDown className="transition-transform group-open:rotate-180 text-primary w-5 h-5" />
                  </summary>
                  <div className="px-6 pb-6 text-textSecondary text-sm leading-relaxed">
                    Да, для индивидуальных занятий перенос возможен за 24 часа до начала. Для групповых занятий доступна видеозапись урока, если вы его пропустили.
                  </div>
                </details>
              </Reveal>
            </div>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="bg-surfaceLow w-full py-12 px-6 border-t border-border mt-auto">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-12 w-full max-w-7xl mx-auto mb-16">
          <div>
            <span className="font-serif italic font-bold text-2xl text-primary block mb-4">{school.name}</span>
            <p className="text-textSecondary text-sm max-w-xs mb-8">
              Создаем будущее, сохраняя традиции академического образования в цифровом мире.
            </p>
            {school.email && (
              <a className="w-10 h-10 rounded-full bg-border flex items-center justify-center text-primary hover:bg-primary hover:text-white transition shadow-sm" href={`mailto:${school.email}`}>
                <Mail size={18} />
              </a>
            )}
          </div>
          <div>
            <h4 className="text-xs font-bold uppercase tracking-widest text-primary mb-6">Контакты</h4>
            {school.phone && <p className="text-textSecondary text-sm mb-3 font-medium">{school.phone}</p>}
            {school.email && <p className="text-textSecondary text-sm mb-3 font-medium">{school.email}</p>}
            {school.city && <p className="text-textSecondary text-sm font-medium">г. {school.city}</p>}
          </div>
        </div>

        <div className="max-w-7xl mx-auto pt-8 border-t border-border flex flex-col md:flex-row justify-between items-center gap-4">
          <p className="text-textSecondary text-xs">© {new Date().getFullYear()} {school.name}. Empowered by Shamdan.</p>
          <div className="flex gap-6">
            <CreditCard className="text-textSecondary/50 w-6 h-6" />
            <Landmark className="text-textSecondary/50 w-6 h-6" />
          </div>
        </div>
      </footer>
    </div>
  );
}
