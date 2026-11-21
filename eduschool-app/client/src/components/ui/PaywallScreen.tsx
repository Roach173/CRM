import { useState } from 'react';
import { useAuth } from '../../hooks/useAuth';
import toast from 'react-hot-toast';
import api from '../../lib/api';

export function PaywallScreen() {
  const { school, refreshSubscriptionStatus, logout } = useAuth();
  const [checking, setChecking] = useState(false);

  const handleCheckPayment = async () => {
    setChecking(true);
    try {
      const res = await api.get('/subscription/status');
      if (res.data.success) {
        const sub = res.data.data;
        if (sub.status !== 'BLOCKED') {
          toast.success('Оплата подтверждена! Доступ восстановлен.');
          await refreshSubscriptionStatus();
        } else {
          toast.error('Оплата пока не подтверждена. Пожалуйста, попробуйте позже или свяжитесь с поддержкой.');
        }
      }
    } catch {
      toast.error('Не удалось проверить статус оплаты. Попробуйте позже.');
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-6">
      <div className="max-w-md w-full text-center space-y-6">
        <div className="w-16 h-16 rounded-2xl bg-danger/10 flex items-center justify-center mx-auto">
          <svg className="w-8 h-8 text-danger" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
          </svg>
        </div>

        <div className="space-y-2">
          <h1 className="text-2xl font-serif text-textPrimary">Доступ приостановлен</h1>
          <p className="text-textSecondary text-sm leading-relaxed">
            Пробный период {school?.name ? `школы «${school.name}»` : ''} завершён.
            Для продолжения работы необходимо продлить подписку.
          </p>
        </div>

        <div className="bg-surfaceLow rounded-2xl p-6 text-left space-y-3">
          <p className="text-xs font-bold uppercase tracking-widest text-textSecondary">Как оплатить</p>
          <ol className="space-y-2 text-sm text-textPrimary">
            <li className="flex gap-2">
              <span className="w-5 h-5 rounded-full bg-primary/10 text-primary text-xs flex items-center justify-center font-bold shrink-0 mt-0.5">1</span>
              <span>Переведите оплату на Kaspi: <strong>+996 700 000 000</strong></span>
            </li>
            <li className="flex gap-2">
              <span className="w-5 h-5 rounded-full bg-primary/10 text-primary text-xs flex items-center justify-center font-bold shrink-0 mt-0.5">2</span>
              <span>Отправьте скриншот в Telegram: <strong>@eduschool_support</strong></span>
            </li>
            <li className="flex gap-2">
              <span className="w-5 h-5 rounded-full bg-primary/10 text-primary text-xs flex items-center justify-center font-bold shrink-0 mt-0.5">3</span>
              <span>Доступ будет восстановлен в течение часа</span>
            </li>
          </ol>
        </div>

        <div className="flex flex-col gap-3">
          <div className="flex gap-3">
            <button
              onClick={handleCheckPayment}
              disabled={checking}
              className="flex-1 px-4 py-3 rounded-xl bg-primary text-white text-sm font-semibold hover:bg-primary/90 transition-colors text-center disabled:opacity-50"
            >
              {checking ? 'Проверяю...' : 'Проверить оплату'}
            </button>
            <a
              href="https://t.me/eduschool_support"
              target="_blank"
              rel="noopener noreferrer"
              className="flex-1 px-4 py-3 rounded-xl border border-border text-sm font-semibold text-textPrimary hover:bg-surfaceLow transition-colors text-center"
            >
              В поддержку
            </a>
          </div>
          <button
            onClick={logout}
            className="w-full py-3 rounded-xl border border-border text-sm text-textSecondary hover:bg-surfaceLow transition-colors"
          >
            Выйти из аккаунта
          </button>
        </div>
      </div>
    </div>
  );
}
