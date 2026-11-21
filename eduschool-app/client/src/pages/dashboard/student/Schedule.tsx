import { useState, useEffect, useMemo } from 'react';
import { Loader2, ChevronLeft, ChevronRight, StickyNote, X, User, MapPin, Users, CheckCircle2, XCircle, AlertCircle, Pause, Ban } from 'lucide-react';
import api from '../../../lib/api';
import { toast } from 'react-hot-toast';
import { startOfWeek, addDays, format, isToday, startOfMonth, endOfMonth, eachDayOfInterval, isSameMonth, addMonths, parseISO } from 'date-fns';
import { ru } from 'date-fns/locale';
import { useIsMobile } from '../../../hooks/useIsMobile';
import { useBodyScrollLock } from '../../../hooks/useBodyScrollLock';
import { useBackButtonClose } from '../../../hooks/useBackButtonClose';
import { BLOCK_TYPE_LABELS, BLOCK_TYPE_STYLES } from '../../../lib/blockTypeStyle';

// LessonBlock.days — Int[] с 0=Пн..6=Вс. JS getDay() даёт 0=Вс..6=Сб.
const jsDayToBlockIndex = (jsDay: number): number => (jsDay + 6) % 7;

const DAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const MAX_NOTE_LENGTH = 2000;

interface StudentBlock {
  id: number;
  startTime: string;
  endTime: string;
  days: number[];
  level: string;
  chapter: number;
  type: 'GRAMMAR' | 'SPEAKING_CLUB';
  maxStudents: number;
  teacher?: { firstName: string; lastName: string } | null;
  cabinet?: { name: string } | null;
  studentGroup?: { id: number; activeStudentCount: number } | null;
  sessions?: Array<{
    date: string;
    status?: string;
    attendances?: Array<{ status: string; creditDeducted?: boolean }>;
  }>;
}

function LessonCard({ l, dateStr, showTime }: { l: StudentBlock; dateStr: string; showTime?: boolean }) {
  const todayStr = format(new Date(), 'yyyy-MM-dd');
  const isPastCell = dateStr < todayStr;
  const session = l.sessions?.find(s => format(new Date(s.date), 'yyyy-MM-dd') === dateStr);
  const att = session?.attendances?.[0];
  const wasPaused = !!att && att.creditDeducted === false;
  const cancelled = session?.status === 'CANCELLED';
  const typeStyle = BLOCK_TYPE_STYLES[l.type];

  const statusIcon = cancelled ? null
    : wasPaused ? <Pause className="w-4 h-4 text-blue-500 shrink-0" />
    : att?.status === 'PRESENT' ? <CheckCircle2 className="w-4 h-4 text-success shrink-0" />
    : att?.status === 'ABSENT' ? <XCircle className="w-4 h-4 text-danger shrink-0" />
    : att?.status === 'LATE' ? <AlertCircle className="w-4 h-4 text-orange-500 shrink-0" />
    : isPastCell ? <div className="w-4 h-4 rounded-full border-2 border-textSecondary/20 shrink-0" />
    : null;

  return (
    <div
      className={`bg-white p-4 rounded-2xl shadow-sm flex flex-col gap-2 transition-opacity ${cancelled ? 'opacity-50' : isPastCell ? 'opacity-75' : ''}`}
      style={{
        // .border-border in index.css forces border-color via !important, which
        // would silently clobber the colored left accent below — set the whole
        // border here instead of mixing in the Tailwind border-border class.
        border: '1px solid rgb(var(--color-border))',
        borderLeft: `3px solid ${typeStyle?.fg ?? 'rgb(var(--color-primary))'}`,
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-bold text-textPrimary truncate">{l.level}</p>
            {showTime && <span className="text-xs font-mono text-textSecondary shrink-0">{l.startTime}–{l.endTime}</span>}
          </div>
          <span
            className="inline-block text-[10px] font-bold uppercase tracking-wide mt-1.5 px-2 py-0.5 rounded-full"
            style={{ background: typeStyle?.bg, color: typeStyle?.fg }}
          >
            {BLOCK_TYPE_LABELS[l.type] ?? l.type}
          </span>
        </div>
        {cancelled ? (
          <span className="flex items-center gap-1 text-[10px] font-bold text-danger shrink-0">
            <Ban className="w-3.5 h-3.5" /> Отменён
          </span>
        ) : statusIcon}
      </div>

      <div className="space-y-1 text-xs text-textSecondary">
        {l.teacher && (
          <div className="flex items-center gap-1.5">
            <User className="w-3 h-3 shrink-0 opacity-60" />
            <span className="truncate">{l.teacher.firstName} {l.teacher.lastName}</span>
          </div>
        )}
        {l.cabinet && (
          <div className="flex items-center gap-1.5">
            <MapPin className="w-3 h-3 shrink-0 opacity-60" />
            <span className="truncate">{l.cabinet.name}</span>
          </div>
        )}
        {l.studentGroup && (
          <div className="flex items-center gap-1.5">
            <Users className="w-3 h-3 shrink-0 opacity-60" />
            <span>{l.studentGroup.activeStudentCount}/{l.maxStudents} мест</span>
          </div>
        )}
      </div>
    </div>
  );
}

export default function StudentSchedule() {
  const isMobile = useIsMobile();
  const [view, setView] = useState<'week' | 'month'>('week');
  const [myBlocks, setMyBlocks] = useState<StudentBlock[]>([]);
  const [activeDays, setActiveDays] = useState<number[]>([0, 1, 2, 3, 4, 5, 6]);
  const [loading, setLoading] = useState(true);
  const [currentWeekStart, setCurrentWeekStart] = useState(() => startOfWeek(new Date(), { weekStartsOn: 1 }));
  // Mobile: single-day view instead of a horizontally-scrolled 7-column grid.
  const [mobileDay, setMobileDay] = useState(() => jsDayToBlockIndex(new Date().getDay()));
  // Personal per-user day notes (own only) — GET/PUT /calendar-notes/me
  const [notesByDate, setNotesByDate] = useState<Record<string, string>>({});
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  useBodyScrollLock(!!selectedDay);
  useBackButtonClose(!!selectedDay, () => setSelectedDay(null));
  const [noteDraft, setNoteDraft] = useState('');
  const [savingNote, setSavingNote] = useState(false);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      api.get('/schedule/student'),
      api.get('/calendar-notes/me'),
      api.get('/settings/timeslots'),
    ])
      .then(([schedule, notes, timeslots]) => {
        if (schedule.data.success) setMyBlocks(schedule.data.data);
        if (notes.data.success) {
          const map: Record<string, string> = {};
          for (const n of notes.data.data as { date: string; content: string }[]) map[n.date] = n.content;
          setNotesByDate(map);
        }
        const days = timeslots.data?.data?.activeDays;
        if (Array.isArray(days) && days.length > 0) setActiveDays(days);
      })
      .catch(() => {
        toast.error('Ошибка загрузки данных');
      })
      .finally(() => setLoading(false));
  }, []);

  const handlePrev = () => setCurrentWeekStart(prev => view === 'month' ? addMonths(prev, -1) : addDays(prev, -7));
  const handleNext = () => setCurrentWeekStart(prev => view === 'month' ? addMonths(prev, 1) : addDays(prev, 7));
  const handleToday = () => setCurrentWeekStart(startOfWeek(new Date(), { weekStartsOn: 1 }));

  const openNote = (dateStr: string) => {
    setSelectedDay(dateStr);
    setNoteDraft(notesByDate[dateStr] || '');
  };

  const saveNote = async () => {
    if (!selectedDay || noteDraft.length > MAX_NOTE_LENGTH) return;
    const content = noteDraft.trim();
    setSavingNote(true);
    try {
      await api.put(`/calendar-notes/me/${selectedDay}`, { content });
      setNotesByDate(prev => {
        const next = { ...prev };
        if (content) next[selectedDay] = content; else delete next[selectedDay];
        return next;
      });
      setSelectedDay(null);
      toast.success('Заметка сохранена');
    } catch {
      toast.error('Не удалось сохранить заметку');
    } finally {
      setSavingNote(false);
    }
  };

  const dateRangeText = useMemo(() => {
    if (view === 'month') {
      return format(currentWeekStart, 'LLLL yyyy', { locale: ru });
    }
    const start = currentWeekStart;
    const end = addDays(start, 6);
    return `${format(start, 'd MMM', { locale: ru })} — ${format(end, 'd MMM yyyy', { locale: ru })}`;
  }, [currentWeekStart, view]);

  // Days the school actually operates on — no reason to draw a column for a day
  // that's always empty.
  const visibleDayIndices = useMemo(
    () => [...activeDays].filter(d => d >= 0 && d <= 6).sort((a, b) => a - b),
    [activeDays]
  );

  // Only the times the student actually has a lesson — not the school's full
  // slot grid, which is mostly empty rows that have nothing to do with them.
  const timeGrid = useMemo(() => {
    const times = myBlocks.map(b => `${b.startTime}|${b.endTime}`);
    return [...new Set(times)].sort().map(t => {
      const [startTime, endTime] = t.split('|');
      return { startTime, endTime };
    });
  }, [myBlocks]);

  const renderMonthGrid = () => {
    const monthStart = startOfMonth(currentWeekStart);
    const monthEnd = endOfMonth(currentWeekStart);
    const startDate = startOfWeek(monthStart, { weekStartsOn: 1 });
    const endDate = addDays(startOfWeek(monthEnd, { weekStartsOn: 1 }), 6);
    const days = eachDayOfInterval({ start: startDate, end: endDate });

    return (
      <div className="mb-8">
        <div className="flex items-center justify-between mb-4">
          <div className="flex bg-surfaceLow p-1 rounded-2xl items-center">
            <button onClick={handlePrev} className="p-2 hover:bg-white rounded-xl text-textSecondary transition">
              <ChevronLeft className="w-4 h-4" />
            </button>
            <div className="px-2 md:px-4 text-center min-w-[120px] md:min-w-[200px]">
              <span className="text-xs font-black uppercase tracking-widest text-textPrimary">{dateRangeText}</span>
            </div>
            <button onClick={handleNext} className="p-2 hover:bg-white rounded-xl text-textSecondary transition">
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
          <button onClick={handleToday} className="px-4 py-2 bg-surfaceLow hover:bg-primaryContainer/20 rounded-xl text-[10px] font-black uppercase tracking-widest text-primary transition">
            Сегодня
          </button>
        </div>
        <div className="grid grid-cols-7 gap-px bg-border rounded-2xl overflow-hidden border border-border">
          {DAYS.map(d => (
            <div key={d} className="bg-surfaceLowest p-3 text-center text-[10px] font-black uppercase text-textSecondary">{d}</div>
          ))}
          {days.map((day) => {
            const dateStr = format(day, 'yyyy-MM-dd');
            const isCurrentMonth = isSameMonth(day, monthStart);
            const hasNote = !!notesByDate[dateStr];

            // Lessons scheduled this weekday — from the block's own days, not just
            // days that already have a generated session, so future weeks show
            // something too instead of an unlabeled dot.
            const dayIdx = jsDayToBlockIndex(day.getDay());
            const dayLessons = myBlocks.filter(b => b.days.includes(dayIdx));

            return (
              <div
                key={dateStr}
                onClick={() => openNote(dateStr)}
                className={`min-h-[48px] md:min-h-[100px] p-1 md:p-3 border-t border-l border-border/5 ${isCurrentMonth ? 'bg-surfaceLowest' : 'bg-surfaceLow/30'} flex flex-col cursor-pointer hover:bg-primary/5 transition-colors group`}
              >
                <div className="flex items-start justify-between">
                  <div className={`text-xs font-bold w-7 h-7 flex items-center justify-center rounded-full mb-2 ${isToday(day) ? 'bg-primary text-white shadow-md' : 'text-textSecondary/50'}`}>
                    {format(day, 'd')}
                  </div>
                  {hasNote ? (
                    <StickyNote className="w-3 h-3 mt-1 shrink-0 text-amber-500" />
                  ) : (
                    <StickyNote className="w-3 h-3 mt-1 shrink-0 text-textSecondary/20 opacity-0 group-hover:opacity-100 transition-opacity" />
                  )}
                </div>
                {hasNote && (
                  <p className="text-[9px] text-amber-700 leading-tight line-clamp-2 mb-1">{notesByDate[dateStr]}</p>
                )}
                <div className="flex flex-col gap-0.5 mt-auto">
                  {dayLessons.slice(0, 2).map(l => {
                    const typeStyle = BLOCK_TYPE_STYLES[l.type];
                    const session = l.sessions?.find(s => format(new Date(s.date), 'yyyy-MM-dd') === dateStr);
                    const att = session?.attendances?.[0];
                    const wasPaused = !!att && att.creditDeducted === false;
                    const dotColor = wasPaused || att?.status === 'FROZEN' ? 'bg-blue-400'
                      : att?.status === 'PRESENT' ? 'bg-success'
                      : att?.status === 'ABSENT' ? 'bg-danger'
                      : att?.status === 'LATE' ? 'bg-orange-500'
                      : null;
                    return (
                      <div
                        key={l.id}
                        title={`${l.level} — ${BLOCK_TYPE_LABELS[l.type] ?? l.type}`}
                        className="flex items-center gap-1 text-[8px] md:text-[9px] font-bold px-1 py-0.5 rounded truncate"
                        style={{ background: typeStyle?.bg, color: typeStyle?.fg }}
                      >
                        {dotColor && <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotColor}`} />}
                        <span className="truncate">{l.level}</span>
                      </div>
                    );
                  })}
                  {dayLessons.length > 2 && (
                    <span className="text-[8px] text-textSecondary/50 font-bold pl-1">+{dayLessons.length - 2}</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // Mobile: one day at a time with a day-tab strip, instead of horizontally
  // scrolling a 7-column grid built for desktop width.
  const renderMobileWeek = () => {
    const cellDateStr = format(addDays(currentWeekStart, mobileDay), 'yyyy-MM-dd');
    const dayLessons = myBlocks
      .filter(l => l.days.includes(mobileDay))
      .sort((a, b) => a.startTime.localeCompare(b.startTime));

    return (
      <div className="mb-8">
        <div className="flex items-center justify-between mb-4">
          <div className="flex bg-surfaceLow p-1 rounded-2xl items-center gap-1">
            <button onClick={handlePrev} className="p-2 hover:bg-white rounded-xl text-textSecondary transition">
              <ChevronLeft className="w-4 h-4" />
            </button>
            <div className="px-3 text-center min-w-[140px]">
              <span className="text-[10px] font-black uppercase tracking-widest text-textPrimary">{dateRangeText}</span>
            </div>
            <button onClick={handleNext} className="p-2 hover:bg-white rounded-xl text-textSecondary transition">
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
          <button onClick={handleToday} className="px-3 py-2 bg-surfaceLow hover:bg-primaryContainer/20 rounded-xl text-[9px] font-black uppercase tracking-widest text-primary transition">
            Сегодня
          </button>
        </div>

        <div className="flex gap-1 overflow-x-auto no-scrollbar mb-4 pb-1">
          {visibleDayIndices.map(i => {
            const date = addDays(currentWeekStart, i);
            const active = mobileDay === i;
            const todayFlag = isToday(date);
            return (
              <button
                key={i}
                onClick={() => setMobileDay(i)}
                className={`flex flex-col items-center gap-0.5 px-3 py-2 rounded-xl flex-shrink-0 transition ${active ? 'bg-primary text-white shadow' : 'text-textSecondary hover:bg-surfaceLow'}`}
              >
                <span className="text-[9px] uppercase tracking-wider font-bold opacity-70">{DAYS[i]}</span>
                <span className={`text-sm font-bold ${todayFlag && !active ? 'text-primary' : ''}`}>{format(date, 'd')}</span>
              </button>
            );
          })}
        </div>

        <div className="space-y-3">
          {dayLessons.length > 0 ? (
            dayLessons.map(l => <LessonCard key={l.id} l={l} dateStr={cellDateStr} showTime />)
          ) : (
            <div className="py-12 text-center text-textSecondary italic text-sm">Нет занятий в этот день</div>
          )}
        </div>
      </div>
    );
  };

  const renderDesktopWeek = () => (
    <div className="overflow-x-auto scroll-fade-x mb-8">
      <div className="min-w-[900px]">
        <div className="flex items-center justify-between mb-4 pl-[4.5rem]">
          <div className="flex bg-surfaceLow p-1 rounded-2xl items-center gap-1">
            <button onClick={handlePrev} className="p-2 hover:bg-white rounded-xl text-textSecondary transition">
              <ChevronLeft className="w-4 h-4" />
            </button>
            <div className="px-4 text-center min-w-[180px]">
              <span className="text-xs font-black uppercase tracking-widest text-textPrimary">{dateRangeText}</span>
            </div>
            <button onClick={handleNext} className="p-2 hover:bg-white rounded-xl text-textSecondary transition">
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
          <button onClick={handleToday} className="px-6 py-2 bg-surfaceLow hover:bg-primaryContainer/20 rounded-xl text-[10px] font-black uppercase tracking-widest text-primary transition">
            Сегодня
          </button>
        </div>

        <div className={`grid mb-6 border-b border-border pb-4`} style={{ gridTemplateColumns: `4.5rem repeat(${visibleDayIndices.length}, 1fr)` }}>
          <div />
          {visibleDayIndices.map(ci => {
            const date = addDays(currentWeekStart, ci);
            const isActive = isToday(date);
            return (
              <div key={ci} className={`flex flex-col items-center gap-1 ${isActive ? 'scale-110' : ''}`}>
                <span className={`text-[10px] font-black uppercase tracking-widest ${isActive ? 'text-primary' : 'text-textSecondary/60'}`}>{DAYS[ci]}</span>
                <span className={`w-8 h-8 flex items-center justify-center rounded-full text-sm font-serif ${isActive ? 'bg-primary text-white shadow-lg shadow-primary/20' : 'text-textPrimary'}`}>
                  {format(date, 'd')}
                </span>
              </div>
            );
          })}
        </div>

        <div className="space-y-4">
          {timeGrid.length > 0 ? timeGrid.map(({ startTime, endTime }) => (
            <div key={`${startTime}-${endTime}`} className="grid items-start min-h-[150px]" style={{ gridTemplateColumns: `4.5rem repeat(${visibleDayIndices.length}, 1fr)` }}>
              <div className="text-xs font-mono font-medium text-textSecondary/40 pt-4 pr-2">{startTime}<br />{endTime}</div>
              {visibleDayIndices.map(ci => {
                const date = addDays(currentWeekStart, ci);
                const cellDateStr = format(date, 'yyyy-MM-dd');
                const lessons = myBlocks.filter(l => l.startTime === startTime && l.endTime === endTime && l.days.includes(ci));
                return (
                  <div key={ci} className="px-1 space-y-2">
                    {lessons.map(l => <LessonCard key={l.id} l={l} dateStr={cellDateStr} />)}
                  </div>
                );
              })}
            </div>
          )) : (
            <div className="py-20 text-center text-textSecondary italic">У вас пока нет активных групп</div>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div className="animate-in fade-in duration-500">
      <div className="mb-10 flex flex-col md:flex-row justify-between items-start md:items-center gap-8">
        <div>
          <h1 className="font-serif text-2xl text-textPrimary">Мой календарь</h1>
          <p className="text-textSecondary text-sm mt-0.5">Планируйте обучение и следите за прогрессом</p>
        </div>

        <div className="flex bg-surfaceLow p-1 rounded-2xl border border-border/5">
          <button onClick={() => setView('week')} className={`px-5 py-2 rounded-xl text-xs transition ${view === 'week' ? 'bg-surfaceLowest shadow-sm text-primary font-bold' : 'text-textSecondary'}`}>
            Неделя
          </button>
          <button onClick={() => setView('month')} className={`px-5 py-2 rounded-xl text-xs transition ${view === 'month' ? 'bg-surfaceLowest shadow-sm text-primary font-bold' : 'text-textSecondary'}`}>
            Месяц
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex flex-col items-center justify-center py-20 gap-4">
          <Loader2 className="w-12 h-12 text-primary animate-spin" />
          <p className="text-textSecondary font-medium">Загружаем ваше расписание...</p>
        </div>
      ) : (
        <>
          {view === 'week'
            ? (isMobile ? renderMobileWeek() : renderDesktopWeek())
            : renderMonthGrid()}
        </>
      )}

      {/* Personal note modal */}
      {selectedDay && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => setSelectedDay(null)}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-2xl max-h-[90dvh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2">
                <StickyNote className="w-4 h-4 text-amber-500" />
                <h3 className="font-serif text-lg text-textPrimary">Заметка</h3>
              </div>
              <button onClick={() => setSelectedDay(null)} className="text-textSecondary hover:text-textPrimary transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-xs text-textSecondary mb-1 capitalize">
              {format(parseISO(selectedDay), 'd MMMM yyyy', { locale: ru })}
            </p>
            <textarea
              className="w-full border border-border rounded-xl p-3 text-sm text-textPrimary resize-none focus:outline-none focus:ring-2 focus:ring-primary/30 mt-2"
              rows={4}
              maxLength={MAX_NOTE_LENGTH}
              placeholder="Напишите заметку на этот день..."
              value={noteDraft}
              onChange={e => setNoteDraft(e.target.value)}
              autoFocus
            />
            <div className={`text-right text-[10px] mt-1 ${noteDraft.length > MAX_NOTE_LENGTH * 0.9 ? 'text-danger' : 'text-textSecondary/50'}`}>
              {noteDraft.length} / {MAX_NOTE_LENGTH}
            </div>
            <div className="flex gap-2 mt-3">
              <button
                onClick={() => setSelectedDay(null)}
                className="flex-1 py-2 rounded-xl border border-border text-sm text-textSecondary hover:bg-surfaceLow transition-colors"
              >
                Отмена
              </button>
              <button
                onClick={saveNote}
                disabled={savingNote || noteDraft.length > MAX_NOTE_LENGTH}
                className="flex-1 py-2 rounded-xl bg-primary text-white text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-60 flex items-center justify-center gap-2"
              >
                {savingNote && <Loader2 className="w-3 h-3 animate-spin" />}
                Сохранить
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
