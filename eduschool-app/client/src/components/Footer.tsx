import { RadioTower } from 'lucide-react';
import type { CTAType } from '../data/features';

type FooterProps = {
  onOpenForm: (type: CTAType) => void;
};

const links = ['Возможности', 'Аналитика', 'Демо', 'Аудит', 'Контакты'];

export function Footer({ onOpenForm }: FooterProps) {
  return (
    <footer className="landing-section flex min-h-[42svh] items-center bg-[#f7f7f1] px-4 py-12 text-black sm:px-6 lg:px-8" data-snap-section>
      <div className="mx-auto flex w-full max-w-7xl flex-col justify-between gap-10 md:flex-row md:items-center">
        <div>
          <div className="flex items-center gap-3">
            <span className="grid h-11 w-11 place-items-center rounded-lg bg-black text-[#b7ff3c]">
              <RadioTower className="h-5 w-5" />
            </span>
            <div className="text-sm font-black leading-tight">
              Command
              <br />
              School CRM
            </div>
          </div>
          <p className="mt-4 max-w-sm text-sm font-semibold text-black/68">CRM и аналитика для языковых школ</p>
          <p className="mt-6 text-xs font-bold text-black/55">© 2026 Command School CRM</p>
        </div>

        <nav className="flex flex-wrap gap-5 text-sm font-black text-black/68">
          {links.map((link) => (
            <span key={link}>{link}</span>
          ))}
        </nav>

        <button className="rounded-lg bg-black px-5 py-3 text-sm font-black text-white transition hover:bg-[#b7ff3c] hover:text-black" onClick={() => onOpenForm('audit')} type="button">
          Получить аудит
        </button>
      </div>
    </footer>
  );
}
