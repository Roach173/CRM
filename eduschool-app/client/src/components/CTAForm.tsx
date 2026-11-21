import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { actionLabels, type CTAType } from '../data/features';
import { useBodyScrollLock } from '../hooks/useBodyScrollLock';
import { useBackButtonClose } from '../hooks/useBackButtonClose';

type CTAFormProps = {
  open: boolean;
  type: CTAType;
  onClose: () => void;
};

const typeOptions: CTAType[] = ['audit', 'demo', 'consultation'];

export function CTAForm({ open, type, onClose }: CTAFormProps) {
  const [selectedType, setSelectedType] = useState<CTAType>(type);
  const [sent, setSent] = useState(false);

  useBodyScrollLock(open);
  useBackButtonClose(open, onClose);

  useEffect(() => {
    if (!open) return undefined;

    setSelectedType(type);
    setSent(false);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);

    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, open, type]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          aria-modal="true"
          className="fixed inset-0 z-[90] grid place-items-center bg-black/55 px-4"
          initial={{ opacity: 0 }}
          role="dialog"
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <motion.div
            className="relative w-full max-w-xl overflow-hidden rounded-xl border border-black/10 bg-[#f7f7f1] p-6 text-[#111315] shadow-[0_30px_120px_rgba(0,0,0,.38)]"
            initial={{ opacity: 0, y: 26, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.98 }}
            transition={{ duration: 0.28 }}
          >
            <button
              aria-label="Закрыть форму"
              className="absolute right-4 top-4 grid h-10 w-10 place-items-center rounded-lg border border-black/10 bg-white hover:bg-black hover:text-white"
              onClick={onClose}
              type="button"
            >
              <X className="h-5 w-5" />
            </button>

            {sent ? (
              <div className="py-10">
                <div className="mb-6 grid h-14 w-14 place-items-center rounded-lg bg-[#b7ff3c] text-2xl font-black text-black">✓</div>
                <h2 className="max-w-md text-3xl font-black leading-tight text-[#111315]">Заявка принята.</h2>
                <p className="mt-4 max-w-md text-base font-semibold text-black/65">
                  Мы свяжемся с вами и покажем, где система может вернуть контроль.
                </p>
                <button className="mt-8 rounded-lg bg-black px-5 py-3 text-sm font-black text-white hover:bg-[#b7ff3c] hover:text-black" onClick={onClose} type="button">
                  Закрыть
                </button>
              </div>
            ) : (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  setSent(true);
                }}
              >
                <p className="text-xs font-black uppercase tracking-[0.18em] text-black/62">Следующий шаг</p>
                <h2 className="mt-3 max-w-md text-3xl font-black leading-tight text-[#111315]">{actionLabels[selectedType]}</h2>
                <p className="mt-3 max-w-md text-sm font-semibold text-black/60">
                  Заполните короткую форму. Без продажи в лоб: сначала покажем, где школа теряет заявки, деньги и контроль.
                </p>

                <div className="mt-6 grid gap-4 sm:grid-cols-2">
                  <label className="grid gap-2 text-sm font-black">
                    Имя
                    <input className="rounded-lg border border-black/10 bg-white px-4 py-3 font-semibold outline-none focus:border-black" required />
                  </label>
                  <label className="grid gap-2 text-sm font-black">
                    Телефон
                    <input className="rounded-lg border border-black/10 bg-white px-4 py-3 font-semibold outline-none focus:border-black" required type="tel" />
                  </label>
                  <label className="grid gap-2 text-sm font-black">
                    Название школы
                    <input className="rounded-lg border border-black/10 bg-white px-4 py-3 font-semibold outline-none focus:border-black" required />
                  </label>
                  <label className="grid gap-2 text-sm font-black">
                    Количество учеников
                    <input className="rounded-lg border border-black/10 bg-white px-4 py-3 font-semibold outline-none focus:border-black" min="1" required type="number" />
                  </label>
                </div>

                <label className="mt-4 grid gap-2 text-sm font-black">
                  Что хотите получить
                  <select
                    className="rounded-lg border border-black/10 bg-white px-4 py-3 font-semibold outline-none focus:border-black"
                    onChange={(event) => setSelectedType(event.target.value as CTAType)}
                    value={selectedType}
                  >
                    {typeOptions.map((option) => (
                      <option key={option} value={option}>
                        {actionLabels[option]}
                      </option>
                    ))}
                  </select>
                </label>

                <button className="mt-6 w-full rounded-lg bg-black px-5 py-4 text-sm font-black text-white transition hover:bg-[#b7ff3c] hover:text-black" type="submit">
                  Отправить заявку
                </button>
              </form>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
