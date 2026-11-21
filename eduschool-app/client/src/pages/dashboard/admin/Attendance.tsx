import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, RefreshCw, Clock, Users } from 'lucide-react';
import { Spinner } from '../../../components/ui/Spinner';
import api from '../../../lib/api';

interface PendingSession {
  sessionId: number;
  date: string;
  lessonBlockId: number;
  groupName: string | null;
  level: string | null;
  lessonType: 'GRAMMAR' | 'SPEAKING_CLUB';
  studentCount: number;
  daysSince: number;
}

interface SubmittedSession {
  sessionId: number;
  date: string;
  groupName: string | null;
  level: string | null;
  lessonType: 'GRAMMAR' | 'SPEAKING_CLUB';
  attendanceCount: number;
  submittedByName: string | null;
  submittedAt: string | null;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', weekday: 'short' });
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function lessonTypeLabel(t: 'GRAMMAR' | 'SPEAKING_CLUB') {
  return t === 'GRAMMAR' ? 'Грамматика' : 'Разг. клуб';
}

function SessionMeta({ s }: {
  s: { groupName: string | null; level: string | null; lessonType: 'GRAMMAR' | 'SPEAKING_CLUB'; date: string };
}) {
  return (
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-semibold text-textPrimary text-sm">
          {s.groupName ?? '—'}
          {s.level && <span className="ml-1 text-textSecondary font-normal">· {s.level}</span>}
        </span>
        <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-surfaceLow text-textSecondary">
          {lessonTypeLabel(s.lessonType)}
        </span>
      </div>
      <p className="text-xs text-textSecondary mt-0.5">{formatDate(s.date)}</p>
    </div>
  );
}

export default function Attendance() {
  const [pending, setPending] = useState<PendingSession[]>([]);
  const [submitted, setSubmitted] = useState<SubmittedSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    api.get('/schedule/attendance-dashboard', { params: { days: 14 } })
      .then(res => {
        setPending(res.data.data.pending ?? []);
        setSubmitted(res.data.data.submitted ?? []);
      })
      .catch(() => setError('Не удалось загрузить данные посещаемости'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] gap-4">
        <Spinner />
        <p className="text-textSecondary text-sm animate-pulse">Загрузка посещаемости...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] gap-4">
        <AlertTriangle className="w-8 h-8 text-danger" />
        <p className="text-danger font-medium">{error}</p>
        <button onClick={load} className="text-primary text-sm font-semibold hover:underline">Повторить</button>
      </div>
    );
  }

  return (
    <div className="animate-in fade-in duration-300">
      {/* Header */}
      <div className="flex items-start justify-between mb-8">
        <div>
          <p className="font-sans text-[0.75rem] font-medium tracking-widest uppercase text-primary mb-1">История</p>
          <h1 className="font-serif text-2xl text-textPrimary">Посещаемость</h1>
          <p className="text-textSecondary text-sm mt-1">Последние 14 дней</p>
        </div>
        <button
          onClick={load}
          className="flex items-center gap-2 px-4 py-2 text-xs font-bold text-primary border border-primary/20 rounded-xl hover:bg-primary/5 transition"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Обновить
        </button>
      </div>

      {/* Summary strip */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 mb-8">
        <div className={`p-4 sm:p-5 rounded-2xl border flex items-center gap-3 sm:gap-4 ${pending.length > 0 ? 'bg-danger/5 border-danger/20' : 'bg-surfaceLow border-border/10'}`}>
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${pending.length > 0 ? 'bg-danger/10' : 'bg-surfaceLowest'}`}>
            <AlertTriangle className={`w-5 h-5 ${pending.length > 0 ? 'text-danger' : 'text-textSecondary'}`} />
          </div>
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-widest text-textSecondary mb-0.5">Без посещаемости</p>
            <p className={`text-2xl font-serif ${pending.length > 0 ? 'text-danger' : 'text-textPrimary'}`}>{pending.length}</p>
          </div>
        </div>

        <div className="p-4 sm:p-5 rounded-2xl border bg-primary/5 border-primary/10 flex items-center gap-3 sm:gap-4">
          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0">
            <CheckCircle2 className="w-5 h-5 text-primary" />
          </div>
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-widest text-textSecondary mb-0.5">Сдано недавно</p>
            <p className="text-2xl font-serif text-primary">{submitted.length}</p>
          </div>
        </div>
      </div>

      {/* Pending section */}
      {pending.length > 0 && (
        <section className="mb-8">
          <h2 className="font-serif text-lg text-textPrimary mb-3 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-danger" />
            Требует внимания
          </h2>
          <div className="bg-surfaceLowest rounded-2xl overflow-hidden border border-border/10">
            {pending.map((s, i) => (
              <div
                key={s.sessionId}
                className={`px-6 py-4 flex items-center gap-4 hover:bg-surfaceLow/40 transition-colors ${i > 0 ? 'border-t border-border/10' : ''}`}
              >
                <div className={`flex-shrink-0 w-10 h-10 rounded-xl flex items-center justify-center text-xs font-black ${s.daysSince >= 3 ? 'bg-danger/10 text-danger' : 'bg-orange-50 text-orange-500'}`}>
                  {s.daysSince}д
                </div>
                <SessionMeta s={s} />
                <div className="flex items-center gap-1 text-textSecondary flex-shrink-0">
                  <Users className="w-3.5 h-3.5" />
                  <span className="text-xs font-medium">{s.studentCount}</span>
                </div>
                <span className={`text-[10px] font-bold uppercase px-2.5 py-1 rounded-full flex-shrink-0 ${s.daysSince >= 3 ? 'bg-danger/10 text-danger' : 'bg-orange-50 text-orange-500'}`}>
                  {s.daysSince === 0 ? 'Сегодня' : s.daysSince === 1 ? 'Вчера' : `${s.daysSince} дня назад`}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {pending.length === 0 && (
        <div className="mb-8 p-6 bg-primary/5 border border-primary/10 rounded-2xl flex items-center gap-4">
          <CheckCircle2 className="w-6 h-6 text-primary flex-shrink-0" />
          <div>
            <p className="font-semibold text-textPrimary text-sm">Все уроки за последние 14 дней сданы</p>
            <p className="text-xs text-textSecondary mt-0.5">Нет пропущенных записей посещаемости</p>
          </div>
        </div>
      )}

      {/* Submitted section */}
      {submitted.length > 0 && (
        <section>
          <h2 className="font-serif text-lg text-textPrimary mb-3 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-primary" />
            Сдано недавно
          </h2>
          <div className="bg-surfaceLowest rounded-2xl overflow-hidden border border-border/10">
            {submitted.map((s, i) => (
              <div
                key={s.sessionId}
                className={`px-6 py-4 flex items-center gap-4 hover:bg-surfaceLow/40 transition-colors ${i > 0 ? 'border-t border-border/10' : ''}`}
              >
                <div className="flex-shrink-0 w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
                  <CheckCircle2 className="w-4 h-4 text-primary" />
                </div>
                <SessionMeta s={s} />
                <div className="flex items-center gap-1 text-primary flex-shrink-0" title="Отмечено студентов">
                  <Users className="w-3.5 h-3.5" />
                  <span className="text-xs font-semibold">{s.attendanceCount}</span>
                </div>
                {s.submittedByName || s.submittedAt ? (
                  <div className="flex items-center gap-1.5 text-textSecondary flex-shrink-0 text-xs">
                    <Clock className="w-3 h-3" />
                    <span>
                      {s.submittedByName ?? 'Аноним'}
                      {s.submittedAt && ` · ${formatTime(s.submittedAt)}`}
                    </span>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </section>
      )}

      {submitted.length === 0 && pending.length === 0 && (
        <div className="p-12 text-center text-textSecondary">
          <p className="font-serif text-lg mb-2">Нет данных</p>
          <p className="text-sm">За последние 14 дней уроков не найдено</p>
        </div>
      )}
    </div>
  );
}
