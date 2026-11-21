import { Menu, RadioTower, X } from 'lucide-react';
import { useEffect, useState, type RefObject } from 'react';
import type { CTAType } from '../data/features';

type HeaderProps = {
  onOpenForm: (type: CTAType) => void;
  scrollRef: RefObject<HTMLDivElement | null>;
};

const navItems = [
  { label: 'Возможности', id: 'features' },
  { label: 'Аналитика', id: 'analytics' },
  { label: 'Для владельца', id: 'owner' },
  { label: 'Демо', id: 'actions' },
];

export function Header({ onOpenForm, scrollRef }: HeaderProps) {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const node = scrollRef.current;

    const onScroll = () => setScrolled(window.scrollY > 24 || (node?.scrollTop ?? 0) > 24);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    node?.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      node?.removeEventListener('scroll', onScroll);
    };
  }, [scrollRef]);

  const scrollTo = (id: string) => {
    const lenis = (window as any).lenis;
    if (lenis) {
      lenis.scrollTo(`#${id}`, { duration: 1.1 });
    } else {
      document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    setOpen(false);
  };

  return (
    <header
      className={`landing-header fixed inset-x-0 top-0 z-50 transition duration-300 ${
        scrolled ? 'border-b border-black/10 bg-[#f7f7f1]/95 shadow-[0_12px_40px_rgba(0,0,0,.08)]' : 'bg-transparent'
      }`}
    >
      <div className="landing-header-inner mx-auto flex max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        <button className="flex items-center gap-3 text-left" onClick={() => scrollTo('hero')} type="button">
          <span className="grid h-11 w-11 place-items-center rounded-lg bg-black text-[#b7ff3c] shadow-[0_0_28px_rgba(183,255,60,.24)]">
            <RadioTower className="h-5 w-5" />
          </span>
          <span className="text-sm font-black leading-tight text-black">
            Command
            <br />
            School CRM
          </span>
        </button>

        <nav className="hidden items-center gap-8 text-sm font-black text-black/62 lg:flex">
          {navItems.map((item) => (
            <button className="transition hover:text-black" key={item.id} onClick={() => scrollTo(item.id)} type="button">
              {item.label}
            </button>
          ))}
        </nav>

        <div className="hidden items-center gap-3 md:flex">
          <a
            className="rounded-lg border border-black/10 bg-white px-5 py-3 text-sm font-black text-black transition hover:border-black hover:bg-black hover:text-white"
            href="/login"
          >
            Войти
          </a>
          <button
            className="rounded-lg bg-black px-5 py-3 text-sm font-black text-white transition hover:bg-[#b7ff3c] hover:text-black"
            onClick={() => onOpenForm('audit')}
            type="button"
          >
            Получить аудит
          </button>
        </div>

        <button aria-label="Открыть меню" className="grid h-11 w-11 place-items-center rounded-lg border border-black/10 bg-white/70 lg:hidden" onClick={() => setOpen((value) => !value)} type="button">
          {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>

      {open && (
        <div className="border-t border-black/10 bg-[#f7f7f1]/95 px-4 py-4 shadow-xl lg:hidden">
          <div className="mx-auto grid max-w-7xl gap-2">
            {navItems.map((item) => (
              <button className="rounded-lg px-3 py-3 text-left text-sm font-black text-black hover:bg-black hover:text-white" key={item.id} onClick={() => scrollTo(item.id)} type="button">
                {item.label}
              </button>
            ))}
            <a
              className="rounded-lg border border-black/10 bg-white px-3 py-3 text-left text-sm font-black text-black hover:bg-black hover:text-white"
              href="/login"
            >
              Войти
            </a>
            <button className="rounded-lg bg-black px-3 py-3 text-left text-sm font-black text-white" onClick={() => onOpenForm('audit')} type="button">
              Получить аудит
            </button>
          </div>
        </div>
      )}
    </header>
  );
}
