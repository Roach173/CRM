import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { useAuth } from '../../../hooks/useAuth';
import { Spinner } from '../../../components/ui/Spinner';
import { Badge } from '../../../components/ui/Badge';
import { EmptyState } from '../../../components/ui/EmptyState';
import { CreditStatement } from '../../../components/ui/CreditStatement';
import api from '../../../lib/api';
import { getNotificationItemsFromResponse } from '../../../lib/notificationsRealtime';
import { Calendar, AlertCircle, BookOpen, BarChart3, Bell } from 'lucide-react';

// LessonBlock.days — Int[] с 0=Пн..6=Вс. JS getDay() даёт 0=Вс..6=Сб,
// поэтому конвертируем через (getDay() + 6) % 7 (как на бэке в schedule.ts).
const toBlockDayIndex = (jsDay: number): number => (jsDay + 6) % 7;

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) return 'Доброе утро';
  if (hour >= 12 && hour < 18) return 'Добрый день';
  return 'Добрый вечер';
}

function findNextLesson(lessons: any[]): any {
  const today = new Date();
  for (let i = 0; i < 14; i++) {
    const checkDate = new Date(today);
    checkDate.setDate(today.getDate() + i);
    const dayIdx = toBlockDayIndex(checkDate.getDay());
    const block = lessons.find(l => Array.isArray(l.days) && l.days.includes(dayIdx));
    if (block) {
      return { block, date: checkDate };
    }
  }
  return null;
}

export default function Overview() {
  const { slug } = useParams<{ slug: string }>();
  const { user, school } = useAuth();
  const [profile, setProfile] = useState<any>(null);
  const [lessons, setLessons] = useState<any[]>([]);
  const [attendance, setAttendance] = useState<any[]>([]);
  const [notifications, setNotifications] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.get('/students/me/profile'),
      api.get('/schedule/student'),
      api.get('/students/me/attendance'),
      api.get('/notifications').catch(() => ({ data: { data: [] } })),
    ])
      .then(([p, l, a, n]) => {
        setProfile(p.data.data ?? null);
        setLessons(l.data.data ?? []);
        setAttendance(a.data.data ?? []);
        setNotifications(getNotificationItemsFromResponse(n.data));
      })
      .catch(() => { /* intentional — mount fetch */ })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px]">
        <Spinner />
        <p className="text-textSecondary mt-4 animate-pulse">Загрузка данных профиля...</p>
      </div>
    );
  }

  const credits = profile?.credits ?? user?.studentProfile?.credits ?? 0;
  const level = profile?.level ?? user?.studentProfile?.level ?? 'Не указан';
  // Paused lessons (freeze-skipped, or legacy status FROZEN) don't count toward the rate.
  const wasPaused = (a: any) => a.status === 'FROZEN' || a.creditDeducted === false;
  const countable = attendance.filter((a: any) => !wasPaused(a)).length;
  const attended = attendance.filter((a: any) => !wasPaused(a) && (a.status === 'PRESENT' || a.status === 'LATE')).length;
  const attendanceRate = countable > 0 ? Math.round((attended / countable) * 100) : 0;
  const missed = attendance.filter((a: any) => !wasPaused(a) && a.status === 'ABSENT').length;
  const nextLesson = findNextLesson(lessons);

  return (
    <div className="space-y-6 pb-12">
      {/* Welcome Hero */}
      <div className="bg-surfaceLow rounded-2xl p-6 md:p-8 space-y-3 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-widest font-medium text-textSecondary mb-1">{getGreeting()}</p>
            <h1 className="font-serif text-2xl text-textPrimary">
              {user?.firstName}
            </h1>
          </div>
          {school && (
            <Badge variant="info" className="shrink-0">
              {school.name}
            </Badge>
          )}
        </div>
        <div className="flex gap-3 flex-wrap items-center">
          <div className="flex items-center gap-2 text-sm bg-white rounded-lg px-3 py-2">
            <span className="font-semibold text-primary">{level}</span>
          </div>
          <div className="flex items-center gap-2 text-sm bg-white rounded-lg px-3 py-2">
            <span className="text-textSecondary">{lessons.length} групп</span>
          </div>
          <div className="flex items-center gap-2 text-sm bg-white rounded-lg px-3 py-2">
            <span className="text-textSecondary">Кредиты:</span>
            <span className="font-semibold text-primary">{credits}</span>
          </div>
          {credits <= 2 && credits > 0 && (
            <div className="bg-warning/20 text-warning rounded-lg px-3 py-2 text-sm flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              Осталось мало кредитов
            </div>
          )}
          {credits <= 0 && (
            <div className="bg-danger/20 text-danger rounded-lg px-3 py-2 text-sm flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              {credits < 0 ? `Долг: ${Math.abs(credits)} кр.` : 'Баланс исчерпан'}
            </div>
          )}
        </div>
      </div>

      {/* Next Lesson — dominant, full width */}
      <div className="bg-primary text-white rounded-2xl p-6 md:p-10">
        <p className="text-xs uppercase tracking-widest font-medium text-white/60 mb-3">Следующий урок</p>
        {nextLesson ? (
          <div className="space-y-5">
            <div>
              <p className="text-sm text-white/70 mb-1 capitalize">
                {nextLesson.date.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' })}
              </p>
              <p className="text-4xl md:text-5xl font-serif font-bold">
                {nextLesson.block.startTime} – {nextLesson.block.endTime}
              </p>
            </div>
            <div className="flex flex-wrap gap-4 border-t border-white/20 pt-4">
              <div className="flex items-center gap-2 text-sm">
                <span className="text-white/60">Уровень:</span>
                <Badge variant="info">{nextLesson.block.level}</Badge>
              </div>
              {nextLesson.block.teacher && (
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-white/60">Преподаватель:</span>
                  <span className="font-medium">
                    {nextLesson.block.teacher.firstName} {nextLesson.block.teacher.lastName}
                  </span>
                </div>
              )}
              {nextLesson.block.cabinet && (
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-white/60">Кабинет:</span>
                  <span className="font-medium">{nextLesson.block.cabinet.name}</span>
                </div>
              )}
            </div>
          </div>
        ) : (
          <EmptyState
            icon={<Calendar className="w-12 h-12 text-white/30" />}
            title="Нет запланированных уроков"
            description="Обратитесь в администрацию школы, чтобы записаться в группу"
          />
        )}
      </div>

      {/* Выписка по урокам — прозрачность списаний для студента */}
      <div className="bg-white border border-border rounded-2xl p-6 md:p-8 shadow-sm">
        <CreditStatement />
      </div>

      {/* Quick Actions Grid */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { icon: Calendar, label: 'Расписание', path: 'schedule' },
          { icon: BarChart3, label: 'Посещаемость', path: 'attendance' },
          { icon: BookOpen, label: 'Мои занятия', path: 'classes' },
        ].map((action) => (
          <a
            key={action.path}
            href={`/${slug}/student/${action.path}`}
            className="flex flex-col items-center justify-center gap-3 p-4 md:p-6 bg-white border border-border rounded-2xl hover:border-primary/30 hover:bg-primaryContainer/10 transition cursor-pointer"
          >
            <action.icon className="w-6 md:w-8 h-6 md:h-8 text-primary" />
            <span className="text-xs md:text-sm text-center font-medium text-surface">{action.label}</span>
          </a>
        ))}
      </div>

      {/* Attendance Summary */}
      <div className="bg-white border border-border rounded-2xl p-6 shadow-sm">
        <p className="text-xs uppercase tracking-widest font-medium text-textSecondary mb-4">Посещаемость</p>
        <div className="grid grid-cols-3 gap-4">
          <div className="text-center p-4 bg-surfaceLow rounded-xl">
            <p className="text-2xl font-serif font-bold text-primary mb-1">{attendanceRate}%</p>
            <p className="text-xs text-textSecondary">Посещаемость</p>
          </div>
          <div className="text-center p-4 bg-surfaceLow rounded-xl">
            <p className="text-2xl font-serif font-bold text-success mb-1">{attended}</p>
            <p className="text-xs text-textSecondary">Присутствовал</p>
          </div>
          <div className="text-center p-4 bg-surfaceLow rounded-xl">
            <p className="text-2xl font-serif font-bold text-danger mb-1">{missed}</p>
            <p className="text-xs text-textSecondary">Пропуски</p>
          </div>
        </div>
      </div>

      {/* Notifications */}
      {notifications.length > 0 && (
        <div className="bg-white border border-border rounded-2xl p-6 shadow-sm">
          <div className="flex items-center gap-2 mb-4">
            <Bell className="w-5 h-5 text-primary" />
            <h3 className="text-sm font-semibold text-surface">Уведомления</h3>
          </div>
          <div className="space-y-3">
            {notifications.slice(0, 5).map((notif) => (
              <div key={notif.id} className="flex gap-3 p-3 bg-surfaceLow rounded-lg hover:bg-primaryContainer/10 transition-colors">
                <div className="w-2 h-2 rounded-full bg-primary shrink-0 mt-1.5"></div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-surface">{notif.message || notif.body || notif.title}</p>
                  <p className="text-xs text-textSecondary mt-1">
                    {new Date(notif.createdAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
