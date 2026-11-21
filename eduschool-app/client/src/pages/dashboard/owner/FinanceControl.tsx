import { useState, useEffect, useCallback } from 'react';
import { Link, useLocation } from 'react-router';
import { RefreshCw, Loader2, ShieldCheck, AlertTriangle, ArrowUpRight } from 'lucide-react';
import toast from 'react-hot-toast';
import { Button } from '../../../components/ui/Button';
import api from '../../../lib/api';

// ─── Server response types ────────────────────────────────────────────────────

type Severity = 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';

// Deep-link target into the schedule grid — same contract GroupDetail's
// "Открыть в расписании" uses (?openBlockId=&openGroupId=&openStart=&openEnd=),
// consumed by Schedule.tsx.
interface ScheduleTarget {
  blockId: number;
  groupId: number | null;
  startTime: string;
  endTime: string;
}

interface ViolationDetail {
  id: number;
  label: string;
  sublabel?: string;
  scheduleTarget?: ScheduleTarget;
}

interface ConsistencyViolation {
  check: string;
  count: number;
  ids: number[];
  severity: 'CRITICAL' | 'WARNING';
  details?: ViolationDetail[];
}

interface ConsistencyReport {
  checkedAt: string;
  totalViolations: number;
  criticalCount: number;
  warningCount: number;
  violations: ConsistencyViolation[];
}

interface ReconciliationIssue {
  issueType: string;
  severity: Severity;
  entityId: number;
  description: string;
  detail?: ViolationDetail;
}

interface ReconciliationReport {
  checkedAt: string;
  summary: string;
  issues: ReconciliationIssue[];
  countsBySeverity: Record<Severity, number>;
}

// ─── Russian titles + «что делать» ────────────────────────────────────────────
// Keys are the exact server check strings / issueType codes.
// Unmapped entries fall back to the raw server text — new checks degrade
// gracefully instead of breaking the page.

interface RuText { title: string; explain: string; action: string }

const CHECK_RU: Record<string, RuText> = {
  'Attendance on INVALIDATED session (ghost billing risk)': {
    title:   'Посещаемость у недействительного урока',
    explain: 'Урок помечен как недействительный, но по нему есть отметки посещаемости — риск списания за урок, которого не было.',
    action:  'Проверьте эти уроки. Если кредит был списан — оформите ручную корректировку кредита в карточке студента.',
  },
  'TeacherPaymentLesson linked to CANCELLED/INVALIDATED session (phantom salary)': {
    title:   'Зарплата за несостоявшийся урок',
    explain: 'Отменённый или недействительный урок попал в выплату учителю.',
    action:  'Оформите корректировку на странице «Зарплата» (тип: недействительный урок).',
  },
  'Duplicate TeacherPaymentLesson (double salary payment)': {
    title:   'Урок оплачен учителю дважды',
    explain: 'Один и тот же урок входит в две выплаты — двойная оплата.',
    action:  'Сверьте выплаты по этим урокам и оформите корректировку зарплаты на лишнюю сумму.',
  },
  'creditDeducted=true without LessonCreditLog deduction (balance mismatch)': {
    title:   'Списание без записи в журнале кредитов',
    explain: 'У посещения стоит флаг «кредит списан», но записи о списании в журнале нет — баланс нельзя проверить.',
    action:  'Создайте корректирующую запись в журнале кредитов для этих посещений.',
  },
  'LessonCreditLog deduction for CANCELLED session (invalid charge)': {
    title:   'Кредит списан за отменённый урок',
    explain: 'Студент заплатил за урок, который школа отменила.',
    action:  'Верните кредит ручной корректировкой в карточке студента.',
  },
  'UPCOMING SessionStudent for WITHDRAWN student (ghost attendee)': {
    title:   'Отчисленный студент в будущем уроке',
    explain: 'Студент выведен из группы, но всё ещё числится в предстоящих уроках.',
    action:  'Обновите состав будущих уроков этой группы.',
  },
  'LessonBlock with endDate < startDate (zombie block)': {
    title:   'Блок с датой конца раньше начала',
    explain: 'У учебного блока дата окончания раньше даты старта — уроки по нему не создаются корректно.',
    action:  'Исправьте даты блока в редакторе группы.',
  },
  'School with no active SchoolSchedulePolicy (policy gap)': {
    title:   'Нет активной политики расписания',
    explain: 'У школы отсутствует действующая версия настроек расписания.',
    action:  'Откройте настройки школы и сохраните рабочие дни/часы заново.',
  },
  'Active LessonSession with archived parent LessonBlock (zombie session)': {
    title:   'Активный урок у архивного блока',
    explain: 'Блок удалён в архив, но его будущие уроки остались активными.',
    action:  'Отмените эти уроки или восстановите блок.',
  },
  'TeacherPayment lessonsCount ≠ TeacherPaymentLesson.count (denorm inconsistency)': {
    title:   'Счётчик уроков в выплате не сходится',
    explain: 'Число уроков, записанное в выплате, не совпадает с фактическим списком оплаченных уроков.',
    action:  'Откройте выплату на странице «Зарплата» и сверьте список уроков.',
  },
  'Teacher double-booking: same teacher assigned to overlapping blocks simultaneously': {
    title:   'Учитель в двух местах одновременно',
    explain: 'Один учитель назначен на пересекающиеся по времени блоки.',
    action:  'Измените время одного из блоков или назначьте другого учителя.',
  },
  'Student double-booking: Grammar and Club of same group overlap in time/days': {
    title:   'Grammar и Club группы пересекаются по времени',
    explain: 'Два блока одной группы идут одновременно — студенты не могут посетить оба.',
    action:  'Разведите блоки группы по времени или дням.',
  },
  'StudentProfile.credits ≠ sum(LessonCreditLog.amount) — balance diverged from ledger': {
    title:   'Баланс студента не сходится с журналом',
    explain: 'Число кредитов на балансе не равно сумме всех записей журнала. Возможны старые записи до внедрения журнала.',
    action:  'Откройте карточку студента, сверьте историю кредитов и выровняйте баланс корректировкой.',
  },
  'invoice.paidAmount ≠ SUM(confirmed allocations) — payment balance corrupted': {
    title:   'Оплаты по инвойсу не сходятся',
    explain: 'Сумма «оплачено» в инвойсе не равна сумме подтверждённых платежей минус возвраты.',
    action:  'Откройте инвойс на странице «Финансы» и сверьте платежи и возвраты.',
  },
  'invoice net paid exceeds totalAmount — negative outstanding risk': {
    title:   'Оплачено больше суммы инвойса',
    explain: 'По инвойсу принято денег больше, чем он выставлен — переплата.',
    action:  'Оформите возврат переплаты или перенос на другой инвойс.',
  },
  'invoice status inconsistent with net-paid outstanding math': {
    title:   'Статус инвойса не соответствует оплатам',
    explain: 'Например, инвойс помечен «оплачен», хотя по нему остался долг.',
    action:  'Откройте инвойс и обновите его статус согласно фактическим оплатам.',
  },
};

const ISSUE_RU: Record<string, RuText> = {
  R1_COMPLETED_WITHOUT_ATTENDANCE: {
    title:   'Проведённый урок без посещаемости',
    explain: 'Урок завершён, студенты были записаны, но посещаемость не отмечена — кредиты не списаны.',
    action:  'Отметьте посещаемость задним числом на странице «Посещаемость».',
  },
  R2_CANCELLED_SESSION_CREDIT_DEDUCTION: {
    title:   'Кредит списан за отменённый урок',
    explain: 'Студент заплатил за урок, который не состоялся.',
    action:  'Верните кредит ручной корректировкой в карточке студента.',
  },
  R3_INVALIDATED_SESSION_TEACHER_PAYMENT: {
    title:   'Зарплата за недействительный урок',
    explain: 'Недействительный урок вошёл в выплату учителю.',
    action:  'Оформите корректировку на странице «Зарплата» (тип: недействительный урок).',
  },
  R4_MAKEUP_WITHOUT_ORIGINAL_LINK: {
    title:   'Отработка без ссылки на исходный урок',
    explain: 'Урок-отработка не связан с отменённым уроком, который он компенсирует.',
    action:  'Укажите исходный урок для отработки или отмените её.',
  },
  R5_DUPLICATE_MAKEUP_LINK: {
    title:   'Несколько отработок одного урока',
    explain: 'На один отменённый урок создано больше одной активной отработки.',
    action:  'Отмените лишние отработки, оставив одну.',
  },
  R6_SALARY_ON_NON_PAYABLE_SESSION: {
    title:   'Зарплата за отменённый/недействительный урок',
    explain: 'Урок, который не должен оплачиваться, вошёл в выплату учителю.',
    action:  'Оформите корректировку зарплаты по этому уроку.',
  },
  R7_ATTENDANCE_WITHOUT_CREDIT_LOG: {
    title:   'Списание без записи в журнале',
    explain: 'Кредит помечен списанным, но записи в журнале кредитов нет.',
    action:  'Создайте корректирующую запись в журнале кредитов.',
  },
  CHECK_EXECUTION_ERROR: {
    title:   'Проверка не выполнилась',
    explain: 'Одна из проверок завершилась с ошибкой — её результат неизвестен.',
    action:  'Обновите страницу. Если повторяется — сообщите в поддержку.',
  },
};

// ─── Unified card model ───────────────────────────────────────────────────────

interface ProblemCard {
  key: string;
  severity: Severity;
  title: string;
  explain: string;
  action: string;
  count: number;
  ids: number[];
  details: ViolationDetail[];
}

const SEVERITY_ORDER: Record<Severity, number> = { CRITICAL: 0, ERROR: 1, WARNING: 2, INFO: 3 };

const SEVERITY_BADGE: Record<Severity, { label: string; cls: string }> = {
  CRITICAL: { label: 'Критично', cls: 'bg-danger/10 text-danger' },
  ERROR:    { label: 'Ошибка',   cls: 'bg-orange-500/10 text-orange-600' },
  WARNING:  { label: 'Внимание', cls: 'bg-amber-500/10 text-amber-600' },
  INFO:     { label: 'Инфо',     cls: 'bg-border/30 text-textSecondary' },
};

const SEVERITY_BORDER: Record<Severity, string> = {
  CRITICAL: 'border-l-danger',
  ERROR:    'border-l-orange-500',
  WARNING:  'border-l-amber-500',
  INFO:     'border-l-border',
};

function toCards(consistency: ConsistencyReport | null, recon: ReconciliationReport | null): ProblemCard[] {
  const cards: ProblemCard[] = [];

  for (const v of consistency?.violations ?? []) {
    const ru = CHECK_RU[v.check];
    cards.push({
      key:      `c:${v.check}`,
      severity: v.severity,
      title:    ru?.title ?? v.check,
      explain:  ru?.explain ?? '',
      action:   ru?.action ?? 'Обратитесь в поддержку — проверка новая и ещё не описана.',
      count:    v.count,
      ids:      v.ids,
      details:  v.details ?? [],
    });
  }

  // Reconciliation issues are per-entity — group them by issueType into one card.
  const grouped = new Map<string, ReconciliationIssue[]>();
  for (const issue of recon?.issues ?? []) {
    const arr = grouped.get(issue.issueType) ?? [];
    arr.push(issue);
    grouped.set(issue.issueType, arr);
  }
  for (const [issueType, issues] of grouped) {
    const ru = ISSUE_RU[issueType];
    // Within one type, WARNING may coexist with CRITICAL (corrected vs not) — show the worst.
    const worst = issues.reduce<Severity>(
      (acc, i) => (SEVERITY_ORDER[i.severity] < SEVERITY_ORDER[acc] ? i.severity : acc),
      'INFO',
    );
    cards.push({
      key:      `r:${issueType}`,
      severity: worst,
      title:    ru?.title ?? issueType,
      explain:  ru?.explain ?? issues[0]?.description ?? '',
      action:   ru?.action ?? 'Обратитесь в поддержку — проверка новая и ещё не описана.',
      count:    issues.length,
      ids:      issues.map(i => i.entityId),
      details:  issues.map(i => i.detail).filter((d): d is ViolationDetail => !!d),
    });
  }

  return cards.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

// ─── Page ─────────────────────────────────────────────────────────────────────

// Same route as GroupDetail's "Открыть в расписании" — swap the current segment for /schedule.
function scheduleLink(pathname: string, target: ScheduleTarget): string {
  const base = pathname.replace(/\/finance-control$/, '/schedule');
  const params = new URLSearchParams({
    openBlockId: String(target.blockId),
    openStart: target.startTime,
    openEnd: target.endTime,
  });
  if (target.groupId != null) params.set('openGroupId', String(target.groupId));
  return `${base}?${params.toString()}`;
}

export default function FinanceControl() {
  const location = useLocation();
  const [consistency, setConsistency] = useState<ConsistencyReport | null>(null);
  const [recon, setRecon]             = useState<ReconciliationReport | null>(null);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const [cRes, rRes] = await Promise.all([
        api.get('/admin/consistency-check'),
        api.get('/admin/reconciliation'),
      ]);
      setConsistency(cRes.data.data);
      setRecon(rRes.data.data);
    } catch {
      setError(true);
      toast.error('Не удалось выполнить проверку');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const cards = toCards(consistency, recon);
  const criticalTotal = cards.filter(c => c.severity === 'CRITICAL').length;
  const allClean = !loading && !error && cards.length === 0;
  const checkedAt = consistency?.checkedAt ?? recon?.checkedAt;

  return (
    <div className="p-4 md:p-6 max-w-4xl mx-auto space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl md:text-2xl font-bold text-text">Финансовый контроль</h1>
          <p className="text-sm text-textSecondary">
            Автоматическая сверка кредитов, зарплат и оплат
            {checkedAt && ` · проверено ${new Date(checkedAt).toLocaleString('ru-RU')}`}
          </p>
        </div>
        <Button onClick={() => void load()} disabled={loading} variant="secondary">
          <RefreshCw className={`w-4 h-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
          Проверить
        </Button>
      </div>

      {/* Status banner */}
      {loading ? (
        <div className="flex items-center justify-center py-16 text-textSecondary">
          <Loader2 className="w-6 h-6 animate-spin mr-2" />
          Сверяем данные…
        </div>
      ) : error ? (
        <div className="rounded-2xl border border-danger/30 bg-danger/5 p-6 text-center">
          <p className="text-danger font-semibold">Проверка не выполнилась</p>
          <p className="text-sm text-textSecondary mt-1">Попробуйте ещё раз.</p>
        </div>
      ) : allClean ? (
        <div className="rounded-2xl border border-primary/30 bg-primary/5 p-6 flex items-center gap-4">
          <ShieldCheck className="w-10 h-10 text-primary shrink-0" />
          <div>
            <p className="font-bold text-text">Всё сходится</p>
            <p className="text-sm text-textSecondary">
              Все проверки пройдены: балансы студентов, зарплаты учителей и оплаты в порядке.
            </p>
          </div>
        </div>
      ) : (
        <div className="rounded-2xl border border-danger/30 bg-danger/5 p-6 flex items-center gap-4">
          <AlertTriangle className="w-10 h-10 text-danger shrink-0" />
          <div>
            <p className="font-bold text-text">
              Найдено проблем: {cards.length}
              {criticalTotal > 0 && ` (критических: ${criticalTotal})`}
            </p>
            <p className="text-sm text-textSecondary">
              Ниже — что случилось и что сделать. Проверки ничего не меняют сами: все исправления делаете вы.
            </p>
          </div>
        </div>
      )}

      {/* Problem cards */}
      {!loading && !error && cards.map(card => (
        <div key={card.key} className={`rounded-xl border border-border border-l-4 ${SEVERITY_BORDER[card.severity]} bg-surface p-4`}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`inline-flex px-2 py-0.5 rounded-lg text-[10px] font-bold uppercase ${SEVERITY_BADGE[card.severity].cls}`}>
                  {SEVERITY_BADGE[card.severity].label}
                </span>
                <h3 className="font-semibold text-text">{card.title}</h3>
              </div>
              {card.explain && <p className="text-sm text-textSecondary mt-1">{card.explain}</p>}
              <p className="text-sm text-text mt-2">
                <span className="font-semibold">Что делать:</span> {card.action}
              </p>
            </div>
            <span className="shrink-0 inline-flex items-center justify-center min-w-[2rem] h-8 px-2 rounded-lg bg-border/20 text-sm font-bold text-text">
              {card.count}
            </span>
          </div>
          {card.details.length > 0 ? (
            <details className="mt-2" open={card.details.length <= 3}>
              <summary className="text-xs text-textSecondary cursor-pointer select-none">
                Показать записи ({card.details.length}{card.count > card.details.length ? ` из ${card.count}` : ''})
              </summary>
              <div className="mt-1.5 space-y-1">
                {card.details.map(d => (
                  <div key={d.id} className="flex items-center justify-between gap-2 rounded-lg bg-border/10 px-3 py-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-text truncate">{d.label}</p>
                      {d.sublabel && <p className="text-xs text-textSecondary truncate">{d.sublabel}</p>}
                    </div>
                    {d.scheduleTarget && (
                      <Link
                        to={scheduleLink(location.pathname, d.scheduleTarget)}
                        className="shrink-0 inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline"
                      >
                        Открыть в расписании <ArrowUpRight className="w-3.5 h-3.5" />
                      </Link>
                    )}
                  </div>
                ))}
              </div>
            </details>
          ) : card.ids.length > 0 && (
            <details className="mt-2">
              <summary className="text-xs text-textSecondary cursor-pointer select-none">
                ID записей ({card.ids.length > 20 ? 'первые 20' : card.ids.length})
              </summary>
              <p className="text-xs font-mono text-textSecondary mt-1 break-all">
                {card.ids.slice(0, 20).join(', ')}
              </p>
            </details>
          )}
        </div>
      ))}
    </div>
  );
}
