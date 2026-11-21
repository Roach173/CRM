import { useState } from 'react';
import { useAuth } from '../../hooks/useAuth';
import { Lock } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../../lib/api';

export function AccessRestrictedScreen() {
  const { school, refreshSubscriptionStatus, logout } = useAuth();
  const [checking, setChecking] = useState(false);

  const handleCheckAccess = async () => {
    setChecking(true);
    try {
      const res = await api.get('/subscription/status');
      if (res.data.success) {
        const sub = res.data.data;
        if (sub.status !== 'BLOCKED') {
          toast.success('Доступ восстановлен! Перенаправление...');
          await refreshSubscriptionStatus();
        } else {
          toast.error('Доступ пока не восстановлен. Пожалуйста, обратитесь к владельцу организации.');
        }
      }
    } catch {
      toast.error('Не удалось проверить статус доступа. Попробуйте позже.');
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#F9FAFB] p-6 font-sans">
      <div className="max-w-md w-full bg-white rounded-3xl border border-[#E3E5E7] p-8 text-center space-y-6 shadow-[0_4px_12px_rgba(0,0,0,0.05)]">
        <div className="w-16 h-16 rounded-2xl bg-critical-subdued flex items-center justify-center mx-auto text-critical border border-[#F5C0BC]">
          <Lock className="w-8 h-8" />
        </div>

        <div className="space-y-3">
          <h1 className="text-2xl font-bold tracking-tight text-[#202223]">Доступ ограничен</h1>
          <p className="text-[#6D7175] text-sm leading-relaxed">
            Доступ к системе для школы {school?.name ? `«${school.name}»` : ''} временно приостановлен из-за неактивной подписки.
          </p>
        </div>

        <div className="bg-[#FFF5E9] rounded-2xl p-5 border border-[#F5C77B] text-left">
          <p className="text-xs font-bold uppercase tracking-widest text-[#916A00] mb-2">Что делать?</p>
          <p className="text-sm text-[#202223] leading-relaxed">
            Пожалуйста, свяжитесь с владельцем школы (Owner) или администратором организации для продления или активации подписки в CRM.
          </p>
        </div>

        <div className="flex flex-col gap-3 pt-2">
          <button
            onClick={handleCheckAccess}
            disabled={checking}
            className="w-full px-4 py-3 rounded-xl bg-primary text-white text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {checking ? 'Проверяю...' : 'Проверить доступ'}
          </button>
          <button
            onClick={logout}
            className="w-full px-4 py-3 rounded-xl border border-[#E3E5E7] text-sm font-semibold text-[#6D7175] hover:bg-[#F6F6F7] transition-colors"
          >
            Выйти из аккаунта
          </button>
        </div>
      </div>
    </div>
  );
}
