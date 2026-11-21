import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import SuperAdminLayout from '../../../components/layout/SuperAdminLayout';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';
import { Textarea } from '../../../components/ui/Textarea';
import api from '../../../lib/api';
import { ShieldAlert, Cpu, Globe, Database, Save, LifeBuoy } from 'lucide-react';

interface HelpTopic {
  title: string;
  body: string;
  url: string;
}

// Mirrors the server guard in lib/helpTopics.ts. Accepts bare domains
// ("youtube.com/x") by defaulting to https://; null means reject.
function normalizeHelpUrl(raw: string): string | null {
  const url = raw.trim();
  if (!url) return '';
  const withScheme = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return withScheme;
  } catch {
    return null;
  }
}

// Platform-wide help topics shown on every school's /help page (PlatformSettings
// singleton, authored here — see routes/superadmin.ts PATCH /superadmin/help).
function HelpTopicsSection() {
  const [topics, setTopics] = useState<HelpTopic[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get('/superadmin/help').then(res => {
      const help = res.data?.data;
      if (Array.isArray(help)) {
        setTopics(help.map((t: any) => ({
          title: typeof t?.title === 'string' ? t.title : '',
          body:  typeof t?.body === 'string' ? t.body : '',
          url:   typeof t?.url === 'string' ? t.url : '',
        })));
      }
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const update = (i: number, key: keyof HelpTopic) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setTopics(prev => prev.map((t, idx) => (idx === i ? { ...t, [key]: e.target.value } : t)));

  const addTopic = () => setTopics(prev => [...prev, { title: '', body: '', url: '' }]);
  const removeTopic = (i: number) => setTopics(prev => prev.filter((_, idx) => idx !== i));

  async function save() {
    const cleaned = topics
      .map(t => ({ title: t.title.trim(), body: t.body.trim(), url: normalizeHelpUrl(t.url) }))
      .filter(t => t.title);
    if (cleaned.some(t => t.url === null)) {
      toast.error('Ссылка недействительна или использует небезопасный протокол');
      return;
    }
    const payload = cleaned.map(t => ({
      title: t.title,
      ...(t.body ? { body: t.body } : {}),
      ...(t.url ? { url: t.url } : {}),
    }));
    setSaving(true);
    try {
      await api.patch('/superadmin/help', { help: payload });
      toast.success('Раздел «Помощь» сохранён');
    } catch (e: any) {
      toast.error(e?.response?.data?.error || 'Ошибка сохранения');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="bg-surfaceLowest p-10 rounded-[2.5rem] border border-border/5 shadow-sm md:col-span-2">
      <div className="flex items-center gap-4 mb-8">
        <div className="w-12 h-12 rounded-2xl bg-primary/10 flex items-center justify-center text-primary">
          <LifeBuoy className="w-6 h-6" />
        </div>
        <div>
          <h3 className="text-xl font-serif text-textPrimary">Помощь</h3>
          <p className="text-textSecondary text-sm font-medium">Топики на странице «Помощь» — видны всем пользователям всех школ.</p>
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-textSecondary py-4">Загрузка...</p>
      ) : (
        <div className="space-y-4">
          {topics.length === 0 && (
            <p className="text-xs text-textSecondary">Топиков пока нет.</p>
          )}
          {topics.map((t, i) => (
            <div key={i} className="bg-surfaceLow/50 rounded-2xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-textSecondary">Топик {i + 1}</span>
                <button
                  onClick={() => removeTopic(i)}
                  className="text-xs text-danger hover:opacity-70 font-medium"
                >
                  Удалить
                </button>
              </div>
              <Input value={t.title} onChange={update(i, 'title')} placeholder="Заголовок, например «Как добавить студента?»" />
              <Textarea value={t.body} onChange={update(i, 'body')} placeholder="Краткое описание или инструкция" />
              <Input value={t.url} onChange={update(i, 'url')} placeholder="Ссылка (опционально) — example.com/... " />
            </div>
          ))}
          <div className="flex items-center gap-3 pt-2">
            <Button variant="outline" onClick={addTopic}>+ Добавить топик</Button>
            <Button variant="primary" onClick={save} isLoading={saving}>
              <Save className="w-3.5 h-3.5 mr-2" />
              Сохранить
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

export default function SuperAdminSettings() {
  return (
    <SuperAdminLayout>
      <div className="mb-10">
        <span className="text-[0.7rem] font-black uppercase tracking-[0.3em] text-textSecondary mb-2 block">Конфигурация системы</span>
        <h1 className="font-serif text-2xl text-textPrimary">Настройки платформы</h1>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        <HelpTopicsSection />
        <section className="bg-surfaceLowest p-10 rounded-[2.5rem] border border-border/5 shadow-sm">
          <div className="flex items-center gap-4 mb-8">
            <div className="w-12 h-12 rounded-2xl bg-primary/10 flex items-center justify-center text-primary">
              <Globe className="w-6 h-6" />
            </div>
            <h3 className="text-xl font-serif text-textPrimary">Глобальные параметры</h3>
          </div>
          <p className="text-textSecondary text-sm mb-8 font-medium">Управление общими настройками доступности и языковыми пакетами системы.</p>
          <button className="w-full py-4 bg-surfaceLow rounded-2xl text-[0.65rem] font-black uppercase tracking-widest text-textSecondary hover:text-primary transition">
            Открыть конфигурацию
          </button>
        </section>

        <section className="bg-surfaceLowest p-10 rounded-[2.5rem] border border-border/5 shadow-sm">
          <div className="flex items-center gap-4 mb-8">
            <div className="w-12 h-12 rounded-2xl bg-danger/10 flex items-center justify-center text-danger">
              <ShieldAlert className="w-6 h-6" />
            </div>
            <h3 className="text-xl font-serif text-textPrimary">Безопасность</h3>
          </div>
          <p className="text-textSecondary text-sm mb-8 font-medium">Настройка политик аутентификации, 2FA и ограничений доступа по IP.</p>
          <button className="w-full py-4 bg-surfaceLow rounded-2xl text-[0.65rem] font-black uppercase tracking-widest text-textSecondary hover:text-danger transition font-bold">
            Управление безопасностью
          </button>
        </section>

        <section className="bg-surfaceLowest p-10 rounded-[2.5rem] border border-border/5 shadow-sm">
          <div className="flex items-center gap-4 mb-8">
            <div className="w-12 h-12 rounded-2xl bg-primary/10 flex items-center justify-center text-primary">
              <Database className="w-6 h-6" />
            </div>
            <h3 className="text-xl font-serif text-textPrimary">База данных</h3>
          </div>
          <p className="text-textSecondary text-sm mb-8 font-medium">Мониторинг состояния подключений и выполнение системных бэкапов.</p>
          <div className="flex gap-4">
            <div className="flex-1 bg-surfaceLow/50 p-4 rounded-2xl text-center">
              <p className="font-black text-textPrimary">Active</p>
              <p className="text-[0.6rem] text-textSecondary uppercase tracking-widest font-bold opacity-40">Status</p>
            </div>
            <div className="flex-1 bg-surfaceLow/50 p-4 rounded-2xl text-center">
              <p className="font-black text-textPrimary">1.2 GB</p>
              <p className="text-[0.6rem] text-textSecondary uppercase tracking-widest font-bold opacity-40">Storage</p>
            </div>
          </div>
        </section>

        <section className="bg-surfaceLowest p-10 rounded-[2.5rem] border border-border/5 shadow-sm">
          <div className="flex items-center gap-4 mb-8">
            <div className="w-12 h-12 rounded-2xl bg-primary/10 flex items-center justify-center text-primary">
              <Cpu className="w-6 h-6" />
            </div>
            <h3 className="text-xl font-serif text-textPrimary">Ресурсы сервера</h3>
          </div>
          <p className="text-textSecondary text-sm mb-8 font-medium">Анализ нагрузки на CPU и использование оперативной памяти контейнерами.</p>
          <div className="h-2 w-full bg-surfaceLow rounded-full overflow-hidden mb-4">
            <div className="h-full bg-primary w-[45%]" />
          </div>
          <p className="text-[0.6rem] text-textSecondary font-black uppercase tracking-widest opacity-40">Load: 45% / 100%</p>
        </section>
      </div>
    </SuperAdminLayout>
  );
}
