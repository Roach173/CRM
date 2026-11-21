import { useMemo, useState } from 'react';
import type { UseSchedule } from '../../hooks/useSchedule';
import { sessionKey } from '../../hooks/schedule/scheduleKeys';
import { lessonWord } from '../../utils/scheduleUtils';

interface Teacher { id: number; firstName: string; lastName: string; }

interface Props {
  teachers: Teacher[];
  sched: UseSchedule;
  tz: string;
}

type TeacherStatus = 'busy-now' | 'free-now' | 'no-lessons';
type FilterTab = 'all' | 'free' | 'busy';

interface TeacherAvail {
  teacher: Teacher;
  status: TeacherStatus;
  lessonsToday: number;
  currentLessonEndsAt: string | null;
  nextLessonStartsAt: string | null;
}

const STATUS_CFG = {
  'busy-now':   { dot: '#C62828', label: 'Ведёт урок',           bg: '#FEF2F2', border: '#FECACA' },
  'free-now':   { dot: '#2D6A4F', label: 'Свободен сейчас',      bg: '#F0FDF4', border: '#BBF7D0' },
  'no-lessons': { dot: '#9CA3AF', label: 'Нет уроков сегодня',   bg: '#F9FAFB', border: '#E5E7EB' },
} as const;

function TeacherCard({ avail }: { avail: TeacherAvail }) {
  const cfg = STATUS_CFG[avail.status];
  return (
    <div style={{
      background: cfg.bg,
      border: `1px solid ${cfg.border}`,
      borderRadius: 10,
      padding: '12px 14px',
      display: 'flex',
      flexDirection: 'column',
      gap: 5,
      minWidth: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{
          width: 9, height: 9, borderRadius: '50%',
          background: cfg.dot, flexShrink: 0, display: 'inline-block',
        }} />
        <span style={{
          fontWeight: 600, fontSize: 14, color: '#111827',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {avail.teacher.firstName} {avail.teacher.lastName}
        </span>
      </div>
      <div style={{ fontSize: 12, paddingLeft: 17, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ color: cfg.dot, fontWeight: 500 }}>{cfg.label}</span>
        {avail.lessonsToday > 0 && (
          <span style={{ color: '#6B7280' }}>
            {avail.lessonsToday} {lessonWord(avail.lessonsToday)} сегодня
          </span>
        )}
        {avail.status === 'busy-now' && avail.currentLessonEndsAt && (
          <span style={{ color: '#9CA3AF' }}>Урок до {avail.currentLessonEndsAt}</span>
        )}
        {avail.status === 'free-now' && avail.nextLessonStartsAt && (
          <span style={{ color: '#9CA3AF' }}>Следующий в {avail.nextLessonStartsAt}</span>
        )}
      </div>
    </div>
  );
}

function Section({ title, accent, items }: { title: string; accent: string; items: TeacherAvail[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <p style={{
        margin: '0 0 8px 0', fontSize: 11, fontWeight: 700, color: accent,
        letterSpacing: '0.06em', textTransform: 'uppercase',
      }}>
        {title} ({items.length})
      </p>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))',
        gap: 10,
      }}>
        {items.map(a => <TeacherCard key={a.teacher.id} avail={a} />)}
      </div>
    </div>
  );
}

export default function TeacherAvailabilityView({ teachers, sched, tz }: Props) {
  const [filter, setFilter] = useState<FilterTab>('all');

  const availability = useMemo((): TeacherAvail[] => {
    const todayISO = new Date().toLocaleDateString('sv-SE', { timeZone: tz });
    const todayDayIdx = (new Date(todayISO + 'T12:00:00').getDay() + 6) % 7;
    const nowHHMM = new Date().toLocaleTimeString('sv-SE', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });

    return teachers.map(teacher => {
      const lessons: Array<{ start: string; end: string }> = [];

      for (const g of Object.values(sched.G)) {
        if (g.status === 'PAUSED' || g.status === 'COMPLETED') continue;

        // Grammar block
        if (g.grammarDays.includes(todayDayIdx)) {
          const blockId = g.grammarBlockId ?? g.id;
          const key = sessionKey(blockId, todayISO);
          const cancelled =
            sched.cancelledSessions[key] === true ||
            sched.sessionStatuses[key] === 'CANCELLED';
          if (!cancelled) {
            const sub = sched.weekSessions[key];
            const tid = (sub?.subTeacherId && sub.subTeacherId > 0) ? sub.subTeacherId : g.tgId;
            if (tid === teacher.id && g.startTime && g.endTime) {
              lessons.push({ start: g.startTime, end: g.endTime });
            }
          }
        }

        // Club block
        if (g.clubDays.includes(todayDayIdx)) {
          const blockId = g.clubBlockId ?? g.linkedIds?.[0];
          if (blockId != null) {
            const key = sessionKey(blockId, todayISO);
            const cancelled =
              sched.cancelledSessions[key] === true ||
              sched.sessionStatuses[key] === 'CANCELLED';
            if (!cancelled) {
              const sub = sched.weekSessions[key];
              const tid = (sub?.subTeacherId && sub.subTeacherId > 0) ? sub.subTeacherId : g.tkId;
              if (tid === teacher.id && g.startTime && g.endTime) {
                lessons.push({ start: g.startTime, end: g.endTime });
              }
            }
          }
        }
      }

      const busyLesson = lessons.find(l => nowHHMM >= l.start && nowHHMM < l.end);

      let status: TeacherStatus;
      let currentLessonEndsAt: string | null = null;
      let nextLessonStartsAt: string | null = null;

      if (busyLesson) {
        status = 'busy-now';
        currentLessonEndsAt = busyLesson.end;
      } else if (lessons.length === 0) {
        status = 'no-lessons';
      } else {
        status = 'free-now';
        const upcoming = lessons
          .filter(l => l.start > nowHHMM)
          .sort((a, b) => a.start.localeCompare(b.start));
        nextLessonStartsAt = upcoming[0]?.start ?? null;
      }

      return { teacher, status, lessonsToday: lessons.length, currentLessonEndsAt, nextLessonStartsAt };
    });
  }, [teachers, sched.G, sched.weekSessions, sched.cancelledSessions, sched.sessionStatuses, tz]);

  const busyNow   = useMemo(() => availability.filter(a => a.status === 'busy-now'),   [availability]);
  const freeNow   = useMemo(() => availability.filter(a => a.status === 'free-now'),   [availability]);
  const noLessons = useMemo(() => availability.filter(a => a.status === 'no-lessons'), [availability]);

  const tabs: Array<{ id: FilterTab; label: string; count: number }> = [
    { id: 'all',  label: 'Все',        count: availability.length },
    { id: 'free', label: 'Свободны',   count: freeNow.length + noLessons.length },
    { id: 'busy', label: 'Ведут урок', count: busyNow.length },
  ];

  const shown = {
    busy:    filter === 'all' || filter === 'busy' ? busyNow   : [],
    free:    filter === 'all' || filter === 'free' ? freeNow   : [],
    noLess:  filter === 'all' || filter === 'free' ? noLessons : [],
  };

  if (teachers.length === 0) {
    return (
      <div style={{ padding: '40px 0', textAlign: 'center', color: '#9CA3AF', fontSize: 14 }}>
        Нет преподавателей
      </div>
    );
  }

  return (
    <div>
      {/* Filter tabs */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 18, flexWrap: 'wrap' }}>
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setFilter(tab.id)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '5px 14px', fontSize: 13,
              fontWeight: filter === tab.id ? 600 : 400,
              border: '1px solid',
              borderColor: filter === tab.id ? '#2D6A4F' : '#E5E7EB',
              borderRadius: 20,
              background: filter === tab.id ? '#2D6A4F' : '#fff',
              color: filter === tab.id ? '#fff' : '#374151',
              cursor: 'pointer', outline: 'none', transition: 'all 0.15s',
            }}
          >
            {tab.label}
            {tab.count > 0 && (
              <span style={{
                fontSize: 11,
                background: filter === tab.id ? 'rgba(255,255,255,0.25)' : '#F3F4F6',
                color: filter === tab.id ? '#fff' : '#6B7280',
                borderRadius: 10, padding: '1px 6px',
              }}>
                {tab.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Teacher sections */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
        <Section title="Ведут урок сейчас"  accent="#C62828" items={shown.busy} />
        <Section title="Свободны сейчас"    accent="#2D6A4F" items={shown.free} />
        <Section title="Нет уроков сегодня" accent="#9CA3AF" items={shown.noLess} />
      </div>

      {shown.busy.length === 0 && shown.free.length === 0 && shown.noLess.length === 0 && (
        <div style={{ padding: '40px 0', textAlign: 'center', color: '#9CA3AF', fontSize: 14 }}>
          Нет данных
        </div>
      )}
    </div>
  );
}
