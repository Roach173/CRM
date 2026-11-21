import { Globe, Mail, MapPin, Link, Copy, CheckCircle } from 'lucide-react';
import { useAuth } from '../../../hooks/useAuth';
import { useEffect, useState } from 'react';
import api from '../../../lib/api';
import { toast } from 'react-hot-toast';

export default function Settings() {
  const { user, school } = useAuth();
  const [schoolData, setSchoolData] = useState<any>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [address, setAddress] = useState('');
  const [saving, setSaving] = useState(false);
  const canEdit = user?.role === 'OWNER';

  useEffect(() => {
    api.get('/settings')
      .then(r => {
        const data = r.data.data;
        setSchoolData(data);
        setName(data?.name || school?.name || '');
        setEmail(data?.email || school?.email || '');
        setAddress(data?.address || '');
      })
      .catch(() => toast.error('Ошибка загрузки данных школы'));
  }, [school?.name, school?.email]);

  const copyPublicLink = () => {
    const slug = schoolData?.slug || school?.slug || '';
    navigator.clipboard.writeText(`${window.location.origin}/${slug}`);
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 2000);
  };

  const saveProfile = async () => {
    if (!canEdit) {
      toast.error('Только владелец школы может изменять настройки');
      return;
    }
    setSaving(true);
    try {
      await api.put('/schools/current/me', { name, email, address });
      toast.success('Настройки сохранены');
    } catch {
      toast.error('Не удалось сохранить настройки');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="text-textPrimary">

      {/* Header */}
      <div className="mb-12">
        <span className="text-[0.75rem] font-black uppercase tracking-[0.3em] text-textSecondary mb-2 block">Конфигурация</span>
        <h1 className="font-serif text-2xl text-textPrimary">Системные настройки</h1>
      </div>

      <div className="space-y-16">

        {/* Профиль школы */}
        <section className="grid grid-cols-1 md:grid-cols-3 gap-12 items-start">
          <div className="md:col-span-1">
            <h3 className="text-2xl font-serif text-textPrimary tracking-tight flex items-center gap-2">
              <Globe className="w-5 h-5 text-primary" />
              Профиль школы
            </h3>
            <p className="text-textSecondary text-sm mt-3 leading-relaxed font-medium">
              Основная информация о вашей школе, видна студентам и преподавателям.
            </p>
          </div>
          <div className="md:col-span-2 bg-surfaceLow p-8 md:p-10 rounded-[2.5rem] space-y-8 border border-border/5 shadow-inner">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
              <div className="flex flex-col gap-3">
                <label className="text-[10px] font-black text-textSecondary uppercase tracking-widest px-1">Название школы</label>
                <input
                  className="bg-surfaceLowest border-none rounded-2xl p-4 text-textPrimary focus:ring-2 focus:ring-primary/20 transition font-bold shadow-sm disabled:opacity-60"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={!canEdit}
                />
              </div>
              <div className="flex flex-col gap-3">
                <label className="text-[10px] font-black text-textSecondary uppercase tracking-widest px-1">Субдомен (slug)</label>
                <div className="flex items-center bg-surfaceLowest rounded-2xl overflow-hidden shadow-sm">
                  <input
                    className="flex-1 bg-transparent border-none p-4 text-textPrimary focus:ring-0 font-bold"
                    type="text"
                    defaultValue={schoolData?.slug || school?.slug || ''}
                  />
                </div>
              </div>
            </div>

            {/* Публичная ссылка */}
            <div className="flex flex-col gap-3">
              <label className="text-[10px] font-black text-textSecondary uppercase tracking-widest px-1 flex items-center gap-2">
                <Link className="w-3 h-3" /> Публичная ссылка школы
              </label>
              <div className="flex gap-2">
                <div className="flex-1 bg-surfaceLowest rounded-2xl px-4 py-3.5 text-sm font-mono text-textSecondary shadow-sm truncate flex items-center">
                  {`${window.location.origin}/${schoolData?.slug || school?.slug || ''}`}
                </div>
                <button
                  onClick={copyPublicLink}
                  className="flex items-center gap-2 px-5 py-3.5 rounded-2xl bg-primary/10 text-primary text-xs font-black uppercase tracking-widest hover:bg-primary hover:text-white transition whitespace-nowrap shadow-sm"
                >
                  {linkCopied
                    ? <><CheckCircle className="w-3.5 h-3.5" /> Скопировано</>
                    : <><Copy className="w-3.5 h-3.5" /> Копировать</>
                  }
                </button>
              </div>
            </div>

            <div className="flex flex-col gap-3">
              <label className="text-[10px] font-black text-textSecondary uppercase tracking-widest px-1">Email</label>
              <div className="relative">
                <Mail className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-textSecondary/40" />
                <input
                  className="w-full bg-surfaceLowest border-none rounded-2xl p-4 pl-12 text-textPrimary focus:ring-2 focus:ring-primary/20 transition font-bold shadow-sm disabled:opacity-60"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={!canEdit}
                />
              </div>
            </div>

            <div className="flex flex-col gap-3">
              <label className="text-[10px] font-black text-textSecondary uppercase tracking-widest px-1">Адрес</label>
              <div className="relative">
                <MapPin className="absolute left-4 top-5 w-4 h-4 text-textSecondary/40" />
                <textarea
                  className="w-full bg-surfaceLowest border-none rounded-2xl p-4 pl-12 text-textPrimary focus:ring-2 focus:ring-primary/20 transition font-bold shadow-sm min-h-[100px] disabled:opacity-60"
                  rows={3}
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  disabled={!canEdit}
                />
              </div>
            </div>

            {canEdit && (
              <div className="flex justify-end pt-4">
                <button
                  onClick={saveProfile}
                  disabled={saving}
                  className="bg-primary text-white px-10 py-3.5 rounded-2xl font-black uppercase tracking-widest text-xs hover:brightness-110 shadow-xl shadow-primary/20 active:scale-95 transition disabled:opacity-60"
                >
                  {saving ? 'Сохранение…' : 'Сохранить'}
                </button>
              </div>
            )}
          </div>
        </section>


      </div>
    </div>
  );
}
