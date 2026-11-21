import { useEffect, useState } from 'react';
import { AlertCircle, Bell, CheckCircle2, Lock } from 'lucide-react';
import { toast } from 'react-hot-toast';
import api from '../../lib/api';
import { Spinner } from '../../components/ui/Spinner';
import type { NotificationPreferenceCategory, NotificationPreferencesResponse } from '../../types';

export default function NotificationPreferences() {
  const [categories, setCategories] = useState<NotificationPreferenceCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [savingCategory, setSavingCategory] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function loadPreferences() {
      setLoading(true);
      setError('');

      try {
        const response = await api.get<{ success: boolean; data: NotificationPreferencesResponse }>('/notifications/preferences');
        if (!active) return;
        setCategories(response.data.data.categories);
      } catch {
        if (!active) return;
        setError('Не удалось загрузить настройки уведомлений');
      } finally {
        if (active) setLoading(false);
      }
    }

    void loadPreferences();

    return () => {
      active = false;
    };
  }, []);

  async function toggleCategory(category: NotificationPreferenceCategory) {
    if (category.locked || savingCategory) return;

    const nextEnabled = !category.enabled;
    const previousCategories = categories;
    setSavingCategory(category.category);
    setCategories(prev => prev.map(item => (
      item.category === category.category ? { ...item, enabled: nextEnabled } : item
    )));

    try {
      const response = await api.patch<{ success: boolean; data: NotificationPreferencesResponse }>(
        '/notifications/preferences',
        { preferences: [{ category: category.category, enabled: nextEnabled }] },
      );
      setCategories(response.data.data.categories);
      toast.success(nextEnabled ? 'Уведомления включены' : 'Уведомления отключены');
    } catch (err: any) {
      setCategories(previousCategories);
      toast.error(err?.response?.data?.error ?? 'Не удалось сохранить настройку');
    } finally {
      setSavingCategory(null);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-[420px] flex-col items-center justify-center">
        <Spinner />
        <p className="mt-4 text-sm text-textSecondary">Загрузка настроек...</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 md:px-8">
      <header className="mb-8">
        <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Bell className="h-5 w-5" />
        </div>
        <h1 className="font-serif text-2xl text-textPrimary">Настройки уведомлений</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-textSecondary">
          Выберите, какие in-app уведомления получать в системе.
        </p>
      </header>

      {error ? (
        <div className="flex items-center gap-3 rounded-lg border border-[#F5C0BC] bg-[#FFF4F4] px-4 py-3 text-sm font-medium text-critical">
          <AlertCircle className="h-4 w-4" />
          {error}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="rounded-lg border border-border bg-surfaceLow px-4 py-3 text-xs font-bold uppercase tracking-wider text-textSecondary">
            Критические и системные уведомления нельзя отключить.
          </div>

          {categories.map(category => {
            const saving = savingCategory === category.category;
            return (
              <section
                key={category.category}
                className="flex flex-col gap-4 rounded-lg border border-border bg-white p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-sm font-bold text-textPrimary">{category.label}</h2>
                    {category.locked && (
                      <span className="inline-flex items-center gap-1 rounded-sm border border-border bg-surfaceLow px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-textSecondary">
                        <Lock className="h-3 w-3" />
                        locked
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-sm leading-6 text-textSecondary">{category.description}</p>
                </div>

                <button
                  type="button"
                  onClick={() => void toggleCategory(category)}
                  disabled={category.locked || savingCategory !== null}
                  className={`flex h-8 w-14 flex-shrink-0 items-center rounded-full p-1 transition-colors ${
                    category.enabled ? 'bg-primary' : 'bg-border'
                  } disabled:cursor-not-allowed disabled:opacity-60`}
                  aria-label={`${category.label}: ${category.enabled ? 'enabled' : 'disabled'}`}
                >
                  <span
                    className={`flex h-6 w-6 items-center justify-center rounded-full bg-white text-primary shadow-sm transition-transform ${
                      category.enabled ? 'translate-x-6' : 'translate-x-0'
                    }`}
                  >
                    {saving ? (
                      <span className="h-3 w-3 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                    ) : category.enabled ? (
                      <CheckCircle2 className="h-3.5 w-3.5" />
                    ) : null}
                  </span>
                </button>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
