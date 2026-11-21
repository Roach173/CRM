import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { RefreshCw, X } from 'lucide-react';
import api from '../../lib/api';
import { pluralRu } from '../../utils/scheduleUtils';
import { DAYS_SHORT as DAYS_RU } from './scheduleTypes';

type TimeConflictReason = 'OUTSIDE_WORK_HOURS' | 'OUTSIDE_POLICY_SLOT';

type SessionConflict = {
  sessionId: number;
  date: string;
  dayIdx: number;
  groupName: string | null;
  level: string | null;
  teacherName: string | null;
  startTime: string;
  endTime: string;
  blockId: number;
  sessionVersion: number;
  cabinetId: number | null;
  teacherUserId: number | null;
  studentGroupId: number | null;
  reason?: TimeConflictReason;
};

type BlockConflict = {
  blockId: number;
  groupName: string | null;
  level: string | null;
  teacherName: string | null;
  startTime: string;
  endTime: string;
  days: number[];
  daysOutsidePolicy: number[];
  timeOutsidePolicy: boolean;
  timeConflictReason?: TimeConflictReason;
  groupStatus: string | null;
  studentGroupId: number | null;
  cabinetId: number | null;
  teacherUserId: number | null;
  conflictDates?: { date: string; dayIdx: number }[];
};

type PolicyConflicts = {
  summary: {
    sessionsOutsideDays: number;
    sessionsOutsideHours: number;
    blocksOutsidePolicy: number;
  };
  firstWorkingDate: string | null;
  sessionsOutsideDays: SessionConflict[];
  sessionsOutsideHours: SessionConflict[];
  blocksOutsidePolicy: BlockConflict[];
  truncatedSessions?: boolean;
  truncatedBlocks?: boolean;
};

type GroupedBlockConflict = BlockConflict & {
  blockIds: number[];
  conflictDates: { date: string; dayIdx: number }[];
  conflictTimes: string[];
  applyFrom: string | null;
  timeConflictReason?: TimeConflictReason;
};

export type PolicyConflictAction =
  | {
      type: 'open-session';
      sessionId: number;
      date: string;
      blockId: number;
      studentGroupId: number | null;
      startTime: string;
      endTime: string;
    }
  | {
      type: 'reschedule-session';
      sessionId: number;
      date: string;
      sessionVersion: number;
      startTime: string;
      endTime: string;
      cabinetId: number | null;
      teacherUserId: number | null;
    }
  | {
      type: 'cancel-session';
      sessionId: number;
      sessionVersion: number;
      date: string;
      blockId: number;
    }
  | {
      type: 'edit-block';
      blockId: number;
      studentGroupId: number | null;
      startTime: string;
      endTime: string;
      applyFrom: string | null;
      focusDate: string | null;
    };

type Props = {
  refreshKey: number;
  className?: string;
  onAction?: (action: PolicyConflictAction) => void;
  onConflictState?: (hasConflicts: boolean) => void;
};

function Dot({ tone }: { tone: 'red' | 'orange' | 'yellow' }) {
  const cls = { red: 'bg-red-500', orange: 'bg-orange-500', yellow: 'bg-yellow-400' }[tone];
  return <span className={`mt-1 h-2.5 w-2.5 flex-none rounded-full ${cls}`} aria-hidden="true" />;
}

function ConflictSection({
  tone, title, children,
}: { tone: 'red' | 'orange' | 'yellow'; title: string; children?: ReactNode }) {
  const toneClasses = {
    red: 'border-red-200 bg-red-50/70 dark:border-red-900/50 dark:bg-red-950/20',
    orange: 'border-orange-200 bg-orange-50/70 dark:border-orange-900/50 dark:bg-orange-950/20',
    yellow: 'border-yellow-200 bg-yellow-50/70 dark:border-yellow-900/50 dark:bg-yellow-950/20',
  }[tone];

  return (
    <section className={`rounded border p-3 ${toneClasses}`}>
      <div className="flex items-start gap-2">
        <Dot tone={tone} />
        <h3 className="m-0 text-sm font-bold leading-5 text-textPrimary">{title}</h3>
      </div>
      {children && <div className="mt-3 space-y-2">{children}</div>}
    </section>
  );
}

function formatDate(iso: string): string {
  return new Date(`${iso}T12:00:00`).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
}

function formatConflictDate(item: { date: string; dayIdx: number }): string {
  return `${DAYS_RU[item.dayIdx]} ${formatDate(item.date)}`;
}

function humanName(value: string | null | undefined, fallback: string): string {
  return value?.trim() || fallback;
}

function uniqSortedNumbers(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function uniqStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function blockConflictKey(item: Pick<BlockConflict, 'blockId' | 'studentGroupId'>): string {
  return item.studentGroupId != null ? `sg:${item.studentGroupId}` : `block:${item.blockId}`;
}

function sessionConflictKey(item: Pick<SessionConflict, 'blockId' | 'studentGroupId'>): string {
  return item.studentGroupId != null ? `sg:${item.studentGroupId}` : `block:${item.blockId}`;
}

function timeRange(item: Pick<BlockConflict, 'startTime' | 'endTime'>): string {
  return `${item.startTime}–${item.endTime}`;
}

function mergeConflictDates(
  a: { date: string; dayIdx: number }[],
  b: { date: string; dayIdx: number }[] = [],
): { date: string; dayIdx: number }[] {
  const map = new Map<string, { date: string; dayIdx: number }>();
  for (const item of [...a, ...b]) map.set(item.date, item);
  return [...map.values()].sort((left, right) => left.date.localeCompare(right.date));
}

function sessionDayConflictsAsBlockConflicts(items: SessionConflict[]): BlockConflict[] {
  return items.map((item) => ({
    blockId: item.blockId,
    groupName: item.groupName,
    level: item.level,
    teacherName: item.teacherName,
    startTime: item.startTime,
    endTime: item.endTime,
    days: [item.dayIdx],
    daysOutsidePolicy: [item.dayIdx],
    timeOutsidePolicy: false,
    groupStatus: null,
    studentGroupId: item.studentGroupId,
    cabinetId: item.cabinetId,
    teacherUserId: item.teacherUserId,
    conflictDates: [{ date: item.date, dayIdx: item.dayIdx }],
  }));
}

function sessionHourConflictsAsBlockConflicts(items: SessionConflict[]): BlockConflict[] {
  return items.map((item) => ({
    blockId: item.blockId,
    groupName: item.groupName,
    level: item.level,
    teacherName: item.teacherName,
    startTime: item.startTime,
    endTime: item.endTime,
    days: [item.dayIdx],
    daysOutsidePolicy: [],
    timeOutsidePolicy: true,
    groupStatus: null,
    studentGroupId: item.studentGroupId,
    cabinetId: item.cabinetId,
    teacherUserId: item.teacherUserId,
    conflictDates: [{ date: item.date, dayIdx: item.dayIdx }],
  }));
}

function groupBlockConflicts(items: BlockConflict[], applyFrom: string | null): GroupedBlockConflict[] {
  const map = new Map<string, GroupedBlockConflict>();

  for (const item of items) {
    const key = blockConflictKey(item);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, {
        ...item,
        blockIds: [item.blockId],
        daysOutsidePolicy: uniqSortedNumbers(item.daysOutsidePolicy),
        conflictDates: mergeConflictDates([], item.conflictDates),
        conflictTimes: item.timeOutsidePolicy ? [timeRange(item)] : [],
        applyFrom,
        timeConflictReason: item.timeConflictReason,
      });
      continue;
    }

    existing.blockIds = uniqSortedNumbers([...existing.blockIds, item.blockId]);
    existing.days = uniqSortedNumbers([...existing.days, ...item.days]);
    existing.daysOutsidePolicy = uniqSortedNumbers([...existing.daysOutsidePolicy, ...item.daysOutsidePolicy]);
    existing.conflictDates = mergeConflictDates(existing.conflictDates, item.conflictDates);
    existing.timeOutsidePolicy = existing.timeOutsidePolicy || item.timeOutsidePolicy;
    existing.conflictTimes = uniqStrings([
      ...existing.conflictTimes,
      ...(item.timeOutsidePolicy ? [timeRange(item)] : []),
    ]);
    // OUTSIDE_WORK_HOURS is more severe — keep the worst reason
    if (item.timeConflictReason) {
      existing.timeConflictReason = existing.timeConflictReason === 'OUTSIDE_WORK_HOURS'
        ? 'OUTSIDE_WORK_HOURS'
        : item.timeConflictReason;
    }
  }

  return [...map.values()];
}

function ActionBtn({
  label, onClick, variant = 'ghost',
}: { label: string; onClick: () => void; variant?: 'ghost' | 'danger' }) {
  const cls = variant === 'danger'
    ? 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30'
    : 'text-primary hover:bg-primary/5 dark:hover:bg-primary/10';
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-2 py-0.5 text-xs font-semibold transition-colors ${cls}`}
    >
      {label}
    </button>
  );
}

function SessionRow({
  item, onAction, onDismiss,
}: { item: SessionConflict; onAction?: (a: PolicyConflictAction) => void; onDismiss: () => void }) {
  return (
    <div className="flex flex-col gap-1.5 rounded border border-red-100 bg-white px-3 py-2 text-sm dark:border-red-900/40 dark:bg-card">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold text-textPrimary">
            Группа {humanName(item.groupName, 'без названия')}
            {item.level != null ? ` · ур. ${item.level}` : ''}
          </div>
          <div className="mt-0.5 truncate text-xs text-textSecondary">
            {humanName(item.teacherName, 'Преподаватель не назначен')}
          </div>
          {item.reason === 'OUTSIDE_POLICY_SLOT' && (
            <div className="mt-0.5 text-xs font-semibold text-orange-600 dark:text-orange-400">
              вне сетки расписания
            </div>
          )}
        </div>
        <div className="flex flex-none items-center gap-1">
          <div className="text-right text-xs font-semibold text-red-700 dark:text-red-300">
            {DAYS_RU[item.dayIdx]} {formatDate(item.date)}, {item.startTime}–{item.endTime}
          </div>
          <button
            type="button"
            onClick={onDismiss}
            title="Скрыть на сейчас"
            aria-label="Скрыть на сейчас"
            className="ml-1 rounded p-0.5 text-textSecondary opacity-50 hover:opacity-100"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      {onAction && (
        <div className="flex flex-wrap gap-1 border-t border-red-100 pt-1.5 dark:border-red-900/30">
          <ActionBtn
            label="Редактировать урок"
            onClick={() => onAction({
              type: 'open-session',
              sessionId: item.sessionId,
              date: item.date,
              blockId: item.blockId,
              studentGroupId: item.studentGroupId,
              startTime: item.startTime,
              endTime: item.endTime,
            })}
          />
          <ActionBtn
            label="Отменить урок"
            variant="danger"
            onClick={() => onAction({
              type: 'cancel-session',
              sessionId: item.sessionId,
              sessionVersion: item.sessionVersion,
              date: item.date,
              blockId: item.blockId,
            })}
          />
        </div>
      )}
    </div>
  );
}

function BlockRow({
  item, onAction, onDismiss,
}: { item: GroupedBlockConflict; onAction?: (a: PolicyConflictAction) => void; onDismiss: () => void }) {
  const conflictDays = item.daysOutsidePolicy.map(d => DAYS_RU[d]).filter(Boolean);
  const conflictDateLabels = item.conflictDates.map(formatConflictDate);
  const conflictTimes = item.conflictTimes;
  return (
    <div className="flex flex-col gap-1.5 rounded border border-orange-100 bg-white px-3 py-2 text-sm dark:border-orange-900/40 dark:bg-card">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold text-textPrimary">
            Группа {humanName(item.groupName, 'без названия')}
            {item.level != null ? ` · ур. ${item.level}` : ''}
          </div>
          <div className="mt-1 space-y-0.5 text-xs text-textSecondary">
            <div>
              <span className="font-semibold text-orange-700 dark:text-orange-300">Конфликтные дни:</span>{' '}
              {conflictDateLabels.length === 0 && (conflictDays.length > 0 ? conflictDays.join(', ') : '—')}
              {conflictDateLabels.length > 0 && (
                <ul className="m-0 mt-1 list-disc space-y-0.5 pl-4">
                  {conflictDateLabels.map(label => <li key={label}>{label}</li>)}
                </ul>
              )}
            </div>
            <div>
              <span className="font-semibold text-orange-700 dark:text-orange-300">
                {item.timeConflictReason === 'OUTSIDE_POLICY_SLOT'
                  ? 'Вне сетки расписания:'
                  : 'Конфликтное время:'}
              </span>{' '}
              {conflictTimes.length > 0 ? conflictTimes.join(', ') : '—'}
            </div>
          </div>
        </div>
        <div className="flex flex-none items-center gap-1">
          <button
            type="button"
            onClick={onDismiss}
            title="Скрыть на сейчас"
            aria-label="Скрыть на сейчас"
            className="ml-1 rounded p-0.5 text-textSecondary opacity-50 hover:opacity-100"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      {onAction && (
        <div className="flex flex-wrap gap-1 border-t border-orange-100 pt-1.5 dark:border-orange-900/30">
          <ActionBtn
            label="Редактировать группу"
            onClick={() => {
              const focusDate = item.conflictDates[0]?.date ?? item.applyFrom;
              if (import.meta.env.DEV) {
                console.debug('[POLICY-EDIT click]', {
                  conflictFirstWorkingDate: item.applyFrom,
                  passedCurrentDate: item.applyFrom,
                  passedSlotId: null,
                  openedBlockId: item.blockId,
                  legacyStartTime: item.startTime,
                  legacyEndTime: item.endTime,
                  focusDate,
                });
              }
              onAction({
                type: 'edit-block',
                blockId: item.blockId,
                studentGroupId: item.studentGroupId,
                startTime: item.startTime,
                endTime: item.endTime,
                applyFrom: item.applyFrom,
                focusDate,
              });
            }}
          />
        </div>
      )}
    </div>
  );
}

export default function PolicyConflictsPanel({ refreshKey, className = '', onAction, onConflictState }: Props) {
  const [data, setData] = useState<PolicyConflicts | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const [dismissedSessionIds, setDismissedSessionIds] = useState<Set<number>>(new Set());
  const [dismissedBlockIds, setDismissedBlockIds] = useState<Set<number>>(new Set());

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(false);
    setDismissedSessionIds(new Set());
    setDismissedBlockIds(new Set());
    try {
      const res = await api.get<{ success: boolean; data?: PolicyConflicts }>('/schedule/policy-conflicts', { signal });
      setData(res.data.data ?? null);
    } catch (err) {
      if (!(err instanceof Error && err.name === 'CanceledError')) setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    load(ctrl.signal);
    return () => ctrl.abort();
  }, [load, refreshKey]);

  const visibleData = useMemo(() => {
    if (!data) return data;
    const visibleSessionDayConflicts = data.sessionsOutsideDays.filter(s => !dismissedSessionIds.has(s.sessionId));
    const visibleSessionHourConflicts = data.sessionsOutsideHours.filter(s => !dismissedSessionIds.has(s.sessionId));
    const visibleBlockConflicts = [
      ...data.blocksOutsidePolicy,
      ...sessionDayConflictsAsBlockConflicts(visibleSessionDayConflicts),
      ...sessionHourConflictsAsBlockConflicts(visibleSessionHourConflicts),
    ].filter(b => !dismissedBlockIds.has(b.blockId));
    const blocksOutsidePolicy = groupBlockConflicts(
      visibleBlockConflicts,
      data.firstWorkingDate,
    );
    const blockCoveredKeys = new Set(
      blocksOutsidePolicy
        .filter(b => b.daysOutsidePolicy.length > 0 || b.conflictDates.length > 0 || b.timeOutsidePolicy)
        .map(blockConflictKey),
    );
    const sessionsOutsideDays = visibleSessionDayConflicts.filter(s =>
      !blockCoveredKeys.has(sessionConflictKey(s))
    );
    const sessionsOutsideHours = visibleSessionHourConflicts.filter(s =>
      !blockCoveredKeys.has(sessionConflictKey(s))
    );

    return {
      ...data,
      sessionsOutsideDays,
      sessionsOutsideHours,
      blocksOutsidePolicy,
      summary: {
        sessionsOutsideDays: sessionsOutsideDays.length,
        sessionsOutsideHours: sessionsOutsideHours.length,
        blocksOutsidePolicy: blocksOutsidePolicy.length,
      },
    };
  }, [data, dismissedSessionIds, dismissedBlockIds]);

  const hasConflicts = useMemo(() => {
    if (!visibleData) return false;
    const s = visibleData.summary;
    return s.sessionsOutsideDays > 0 || s.sessionsOutsideHours > 0 || s.blocksOutsidePolicy > 0;
  }, [visibleData]);

  useEffect(() => {
    if (!loading && !error) onConflictState?.(hasConflicts);
  }, [hasConflicts, loading, error, onConflictState]);

  if (!loading && !error && !hasConflicts) {
    return (
      <div className={`rounded border border-border bg-white p-4 text-center shadow-sm dark:bg-card ${className}`}>
        <p className="text-sm text-textSecondary">Конфликтов политики нет</p>
      </div>
    );
  }

  return (
    <section className={`rounded border border-border bg-white p-3 shadow-sm dark:bg-card ${className}`}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="m-0 text-sm font-bold text-textPrimary">Конфликты политики расписания</h2>
          <p className="m-0 mt-0.5 text-xs text-textSecondary">
            Занятия или блоки вне текущих настроек школы. Система не изменяет их автоматически.
          </p>
        </div>
        {loading && (
          <div className="flex items-center gap-1.5 text-xs text-textSecondary">
            <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            Обновление
          </div>
        )}
      </div>

      {error && (
        <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-300">
          Не удалось загрузить конфликты политики.
        </div>
      )}

      {!error && data && (data.truncatedSessions || data.truncatedBlocks) && (
        <div className="mb-3 rounded border border-yellow-200 bg-yellow-50 px-3 py-2 text-xs text-yellow-800 dark:border-yellow-900/50 dark:bg-yellow-950/20 dark:text-yellow-300">
          Показаны не все конфликты. Уточните фильтр или проверьте расписание.
        </div>
      )}

      {!error && visibleData && hasConflicts && (
        <div className="grid gap-3 lg:grid-cols-2">
          {visibleData.summary.sessionsOutsideDays > 0 && (
            <ConflictSection
              tone="red"
              title={`${visibleData.summary.sessionsOutsideDays} ${pluralRu(visibleData.summary.sessionsOutsideDays, 'занятие', 'занятия', 'занятий')} вне рабочих дней`}
            >
              {visibleData.sessionsOutsideDays.map(item => (
                <SessionRow
                  key={item.sessionId}
                  item={item}
                  onAction={onAction}
                  onDismiss={() => setDismissedSessionIds(prev => new Set([...prev, item.sessionId]))}
                />
              ))}
            </ConflictSection>
          )}

          {visibleData.summary.sessionsOutsideHours > 0 && (
            <ConflictSection
              tone="red"
              title={`${visibleData.summary.sessionsOutsideHours} ${pluralRu(visibleData.summary.sessionsOutsideHours, 'занятие', 'занятия', 'занятий')} вне сетки расписания`}
            >
              {visibleData.sessionsOutsideHours.map(item => (
                <SessionRow
                  key={item.sessionId}
                  item={item}
                  onAction={onAction}
                  onDismiss={() => setDismissedSessionIds(prev => new Set([...prev, item.sessionId]))}
                />
              ))}
            </ConflictSection>
          )}

          {visibleData.summary.blocksOutsidePolicy > 0 && (
            <ConflictSection
              tone="orange"
              title={`${visibleData.summary.blocksOutsidePolicy} ${pluralRu(visibleData.summary.blocksOutsidePolicy, 'блок', 'блока', 'блоков')} вне политики`}
            >
              {visibleData.blocksOutsidePolicy.map(item => (
                <BlockRow
                  key={blockConflictKey(item)}
                  item={item}
                  onAction={onAction}
                  onDismiss={() => setDismissedBlockIds(prev => new Set([...prev, ...item.blockIds]))}
                />
              ))}
            </ConflictSection>
          )}
        </div>
      )}
    </section>
  );
}
