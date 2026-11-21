import { memo } from 'react';
import type { BlockVisibility, SchedGroup } from './scheduleTypes';
import { clubBlockIdOf, grammarBlockIdOf, lessonBlockIdForDay } from './scheduleTypes';
import type { UseSchedule } from '../../hooks/useSchedule';
import { dateKey } from '../../hooks/useSchedule';
import { checkCapacity } from '../../utils/scheduleConflicts';
import * as S from './roomBlockStyles';

import { formatSessionDate } from '../../utils/scheduleUtils';

// Backend-truth badge labels — shown only when no LessonSession governs the cell
// (session facts always take priority, see the sessionMeta gate below). OUT_OF_GRID
// keeps the existing slot-row "вне сетки" treatment instead of a per-card badge.
const VISIBILITY_BADGE_LABEL: Partial<Record<BlockVisibility, string>> = {
  COMPLETED: '✓ Завершён',
  CANCELLED: '✕ Отменён',
  CLOSED_BY_END_DATE: '◐ Закрыт по дате',
  HISTORICAL: '📁 Исторический',
  SOFT_DELETED: '🗑 Удалён',
};

export function visibilityBadgeLabel(group: SchedGroup): string | undefined {
  if (!group.blockVisibility) return undefined;
  // deletedAt outranks CANCELLED in blockVisibility itself (server precedence), but a
  // tombstone that was also explicitly cancelled (not just superseded) is worth showing.
  if (group.blockVisibility === 'SOFT_DELETED' && group.blockStatus === 'CANCELLED') {
    return '🗑 Удалён / Отменён';
  }
  return VISIBILITY_BADGE_LABEL[group.blockVisibility];
}

interface Props {
  group: SchedGroup;
  ci: number;
  sid: number;
  /** This cell's date — callers already have the week's dates memoized. */
  date: Date | undefined;
  sched: UseSchedule;
  timezone?: string;
  onCellClick: () => void;
  isPast: boolean;
  isToday: boolean;
  slotTime?: string;
  /**
   * 'cell' — desktop table cell (~130px wide): the original dense, tiny-type card.
   * 'mobile' — full-width list card (~360px): larger type, cabinet + colour-coded
   * teacher pills on one line. Same state logic, different shell.
   */
  layout?: 'cell' | 'mobile';
}

function RoomBlock({ group, ci, date, sched, timezone = 'Asia/Bishkek', onCellClick, isPast, isToday: _isToday, slotTime, layout = 'cell' }: Props) {
  const dateISO = date ? dateKey(date, timezone) : '';

  const isGrammarDay = group.grammarDays.includes(ci);
  const isClubDay = group.clubDays.includes(ci);
  const grammarBlockId = grammarBlockIdOf(group);
  const clubBlockId = clubBlockIdOf(group);

  const sessionStatus = sched.getSessionStatus(lessonBlockIdForDay(group, ci), dateISO);
  const sessionMeta = sched.getWeekSession(lessonBlockIdForDay(group, ci), dateISO);
  const isLocked = sessionStatus === 'LOCKED';
  const isInProgress = sessionStatus === 'IN_PROGRESS';
  const isCompleted = sessionStatus === 'COMPLETED';
  const isInvalidated = sessionStatus === 'INVALIDATED';
  const cancelled =
    (isGrammarDay && sched.isBlockCancelled(grammarBlockId, dateISO)) ||
    (isClubDay && clubBlockId != null && sched.isBlockCancelled(clubBlockId, dateISO));

  const grammarSub = sched.getSessionSubstitute(grammarBlockId, dateISO);
  const clubSub = clubBlockId ? sched.getSessionSubstitute(clubBlockId, dateISO) : null;

  // Source of Truth: a LessonSession for this exact date always governs rendering
  // (cancelled/locked/inProgress/completed above already read session facts) —
  // the backend-truth badge/muting below is a pure block-plan projection and only
  // applies when no session exists yet for this cell.
  const truthReadOnly = !sessionMeta && !!group.isReadOnly;
  const truthBadgeLabel = truthReadOnly ? visibilityBadgeLabel(group) : undefined;

  const pastBadge = !cancelled && !isLocked && !isInProgress && !isInvalidated && (isPast || isCompleted)
    ? (isCompleted || Boolean(sessionMeta?.attendanceFinalizedAt))
      ? { bg: '#E8F5E9', fg: '#2D6A4F', label: '✓', title: 'Посещаемость сдана' }
      : { bg: '#FFF8E1', fg: '#E65100', label: '!', title: 'Посещаемость не сдана' }
    : null;

  // Group-color background fills removed per request — cards use the neutral surface.
  const textColors = S.blockTextColors(undefined, isPast);
  const bg = cancelled
    ? 'var(--color-surface-lowest)'
    : isInProgress
      ? 'rgba(45,106,79,0.04)'
      : isLocked
        ? 'rgba(0,0,0,0.018)'
        : (isPast || truthReadOnly)
          ? 'rgba(0,0,0,0.012)'
          : 'var(--color-background)';

  const borderColor = cancelled
    ? '#E0E0E0'
    : isLocked
      ? '#D0D0C8'
      : isInProgress
        ? '#2D6A4F'
        : (isPast || truthReadOnly)
          ? '#D0D0C8'
          : 'rgb(var(--color-border))';


  const capacityConflict = !cancelled && !isPast
    ? checkCapacity(group.stu.length, group.cap)
    : null;
  const capacityColor = capacityConflict?.severity === 'warning' ? '#C62828'
    : capacityConflict?.severity === 'info' ? '#E65100'
    : textColors.capacity;

  const tooltipLines = [
    `${group.lv}`,
    group.tg && group.tg !== '—' ? `Гр: ${group.tg}` : null,
    group.tk && group.tk !== '—' ? `Кл: ${group.tk}` : null,
    group.n ? `Каб: ${group.n}` : null,
    `${group.stu.length}/${group.cap} мест`,
    truthReadOnly && group.visibilityReason ? `Причина: ${group.visibilityReason}` : null,
    truthReadOnly && group.blockVisibility === 'SOFT_DELETED' && group.sessionCountInRange
      ? `Сессий на этой неделе: ${group.sessionCountInRange}`
      : null,
  ].filter(Boolean).join('\n');

  // ── Mobile shell ───────────────────────────────────────────────────────────
  // Same state above, laid out for a ~360px full-width card instead of a ~130px
  // table cell: level + capacity on one line, cabinet + teacher pills on the next,
  // and exception chips only when they apply. The cell layout stacks each of these on
  // its own line at 10–13px, which reads as a mostly-empty box at phone width.
  if (layout === 'mobile') {
    // Grammar = green, Club = blue (S.TEACHER_PILL). The Гр:/Кл: prefix stays even
    // when only one block runs that day — colour alone is not a signal a colourblind
    // user can read, and it is what the desktop cell shows.
    type MobileTeacher = { prefix: string; name: string; sub: string | undefined; pill: { bg: string; fg: string } };
    const teachers = [
      isGrammarDay && group.tg && group.tg !== '—'
        ? { prefix: 'Гр', name: group.tg, sub: grammarSub?.subTeacherName, pill: S.TEACHER_PILL.grammar }
        : null,
      isClubDay && group.tk && group.tk !== '—'
        ? { prefix: 'Кл', name: group.tk, sub: clubSub?.subTeacherName, pill: S.TEACHER_PILL.club }
        : null,
    ].filter((t): t is MobileTeacher => t != null);

    const statusMark = cancelled ? { label: '☒', fg: '#f44336', title: 'Урок отменён' }
      : isLocked ? { label: '🔒', fg: '#9E9E9E', title: 'Урок заблокирован' }
      : isInvalidated ? { label: '⚠', fg: '#9E9E9E', title: 'Урок недействителен' }
      : isInProgress ? { label: '●', fg: '#2D6A4F', title: 'Урок идёт сейчас' }
      : null;

    const chips: Array<{ label: string; fg: string; bg: string; title?: string }> = [];
    for (const t of teachers) {
      if (t.sub) chips.push({ label: `Замена: ${t.sub}`, fg: '#fff', bg: '#ff9800' });
    }
    if (sessionMeta?.isMakeup) chips.push({ label: '↩ Доп. урок', fg: '#2D6A4F', bg: '#E8F5E9' });
    if (cancelled && sessionMeta?.makeupSession) {
      chips.push({ label: `Доп. урок: ${formatSessionDate(sessionMeta.makeupSession.date)}`, fg: '#5D4037', bg: '#FFF8E1' });
    }
    if (group.status === 'PAUSED') chips.push({ label: '⏸ Пауза', fg: '#0284C7', bg: '#F0F9FF' });
    if (group.status === 'COMPLETED') chips.push({ label: '✓ Завершена', fg: '#757575', bg: '#F5F5F5' });
    if (truthBadgeLabel) {
      chips.push({ label: truthBadgeLabel, fg: '#757575', bg: '#F5F5F5', title: group.visibilityReason ?? undefined });
    }

    return (
      <div
        onClick={e => { e.stopPropagation(); onCellClick(); }}
        title={tooltipLines}
        style={{
          border: `1px solid ${borderColor}`,
          borderRadius: 10,
          padding: '10px 12px',
          background: bg,
          opacity: cancelled ? 0.55 : isLocked ? 0.85 : isPast ? 0.8 : 1,
          cursor: 'pointer',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              flex: 1, minWidth: 0, fontSize: 15, fontWeight: 700, lineHeight: 1.25,
              color: textColors.primary,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              textDecoration: cancelled ? 'line-through' : undefined,
            }}
          >
            {group.lv}
          </span>
          {statusMark && (
            <span title={statusMark.title} style={{ flexShrink: 0, fontSize: 12, color: statusMark.fg, lineHeight: 1 }}>
              {statusMark.label}
            </span>
          )}
          {!statusMark && pastBadge && (
            <span title={pastBadge.title} style={S.pastBadgeCircle(pastBadge.bg, pastBadge.fg)}>
              {pastBadge.label}
            </span>
          )}
          <span style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 3, fontSize: 13 }}>
            {capacityConflict && <span style={S.capacityWarningIcon}>⚠</span>}
            <span style={S.capacityText(capacityColor, !!capacityConflict)}>
              {group.stu.length}/{group.cap}
            </span>
          </span>
        </div>

        {(group.n || teachers.length > 0 || slotTime) && (
          <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, minWidth: 0 }}>
            {(slotTime || group.n) && (
              <span style={{ fontSize: 13, lineHeight: 1.3, color: textColors.secondary, whiteSpace: 'nowrap' }}>
                {slotTime || group.n}
              </span>
            )}
            {teachers.map(t => (
              <span
                key={t.prefix}
                style={{
                  maxWidth: '100%', minWidth: 0,
                  borderRadius: 8, padding: '2px 7px', fontSize: 12, fontWeight: 600,
                  background: t.pill.bg, color: t.pill.fg,
                  // A substituted teacher stays visible but struck through — the
                  // «Замена: X» chip below names who actually takes the lesson.
                  textDecoration: t.sub ? 'line-through' : 'none',
                  opacity: t.sub ? 0.6 : 1,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}
              >
                {t.prefix}: {t.name}
              </span>
            ))}
          </div>
        )}

        {chips.length > 0 && (
          <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {chips.map(c => (
              <span
                key={c.label}
                title={c.title}
                style={{
                  fontSize: 11, fontWeight: 700, color: c.fg, background: c.bg,
                  borderRadius: 4, padding: '2px 6px',
                }}
              >
                {c.label}
              </span>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      onClick={e => { e.stopPropagation(); onCellClick(); }}
      title={tooltipLines}
      style={S.roomBlockContainer(borderColor, bg, cancelled, isPast, isLocked)}
    >
      {/* Top-right status badge */}
      {cancelled && (
        <span style={S.cancelledBadge}>☒</span>
      )}
      {!cancelled && isLocked && (
        <span title="Урок заблокирован" style={S.lockedBadge}>🔒</span>
      )}
      {!cancelled && !isLocked && isInvalidated && (
        <span title="Урок недействителен" style={{ ...S.lockedBadge, color: '#9E9E9E' }}>⚠</span>
      )}
      {!cancelled && !isLocked && !isInvalidated && isInProgress && (
        <span title="Урок идёт сейчас" style={S.inProgressDot}>●</span>
      )}
      {!cancelled && !isLocked && !isInvalidated && !isInProgress && pastBadge && (
        <span title={pastBadge.title} style={S.pastBadgeCircle(pastBadge.bg, pastBadge.fg)}>
          {pastBadge.label}
        </span>
      )}

      {/* Slot time (replaces cabinet name — cabinet is already shown in the row header) */}
      {slotTime && (
        <div style={S.roomNameText(textColors.primary)}>{slotTime}</div>
      )}

      {/* Level — first line */}
      <div style={S.groupNameText(textColors.primary, false)}>
        {group.lv}
      </div>
      {/* Cabinet — second line (hidden in rooms view: cabinet is already the column header) */}
      {group.n && !slotTime && (
        <div style={{ fontSize: 11, color: textColors.secondary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', paddingRight: 16 }}>
          {group.n}
        </div>
      )}

      {/* Grammar teacher pill — only on grammar days */}
      {isGrammarDay && group.tg && group.tg !== '—' && (
        <div style={{ marginBottom: 2 }}>
          <span style={{
            display: 'inline-block', borderRadius: 8, padding: '1px 5px', fontSize: 11,
            background: S.TEACHER_PILL.grammar.bg, color: S.TEACHER_PILL.grammar.fg, fontWeight: 600,
            textDecoration: grammarSub?.subTeacherName ? 'line-through' : 'none',
            opacity: grammarSub?.subTeacherName ? 0.6 : 1,
            maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            Гр: {group.tg}
          </span>
          {grammarSub?.subTeacherName && (
            <div style={{ marginTop: 2 }}>
              <span style={{ display: 'inline-block', borderRadius: 10, padding: '1px 6px', fontSize: 11, background: '#ff9800', color: '#fff', fontWeight: 700 }}>
                Замена: {grammarSub.subTeacherName}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Club teacher pill — only on club days */}
      {isClubDay && group.tk && group.tk !== '—' && (
        <div style={{ marginBottom: 2 }}>
          <span style={{
            display: 'inline-block', borderRadius: 8, padding: '1px 5px', fontSize: 11,
            background: S.TEACHER_PILL.club.bg, color: S.TEACHER_PILL.club.fg, fontWeight: 600,
            textDecoration: clubSub?.subTeacherName ? 'line-through' : 'none',
            opacity: clubSub?.subTeacherName ? 0.6 : 1,
            maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            Кл: {group.tk}
          </span>
          {clubSub?.subTeacherName && (
            <div style={{ marginTop: 2 }}>
              <span style={{ display: 'inline-block', borderRadius: 10, padding: '1px 6px', fontSize: 11, background: '#ff9800', color: '#fff', fontWeight: 700 }}>
                Замена: {clubSub.subTeacherName}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Capacity */}
      <div style={S.capacityRow}>
        {capacityConflict && <span style={S.capacityWarningIcon}>⚠</span>}
        <span style={S.capacityText(capacityColor, !!capacityConflict)}>
          {group.stu.length}/{group.cap}
        </span>
      </div>

      {sessionMeta?.isMakeup && (
        <div style={{ fontSize: 11, fontWeight: 700, color: '#2D6A4F', background: '#E8F5E9', borderRadius: 3, padding: '1px 5px', marginTop: 2, display: 'inline-block' }}>
          ↩ Доп. урок
        </div>
      )}
      {cancelled && sessionMeta?.makeupSession && (
        <div style={{ fontSize: 11, fontWeight: 700, color: '#5D4037', background: '#FFF8E1', borderRadius: 3, padding: '1px 5px', marginTop: 2, display: 'inline-block' }}>
          Доп. урок: {formatSessionDate(sessionMeta.makeupSession.date)}
        </div>
      )}

      {/* Group lifecycle status badge */}
      {group.status === 'PAUSED' && (
        <div style={{ fontSize: 11, fontWeight: 700, color: '#0284C7', background: '#F0F9FF', borderRadius: 3, padding: '1px 5px', marginTop: 2, display: 'inline-block', whiteSpace: 'nowrap' }}>
          ⏸ Пауза
        </div>
      )}
      {group.status === 'COMPLETED' && (
        <div style={{ fontSize: 11, fontWeight: 700, color: '#757575', background: '#F5F5F5', borderRadius: 3, padding: '1px 5px', marginTop: 2, display: 'inline-block' }}>
          ✓ Завершена
        </div>
      )}
      {/* Backend-truth badge: this specific LessonBlock (not the group) is closed/
          cancelled/completed and no session governs this date — see truthReadOnly. */}
      {truthBadgeLabel && (
        <div title={group.visibilityReason} style={{ fontSize: 11, fontWeight: 700, color: '#757575', background: '#F5F5F5', borderRadius: 3, padding: '1px 5px', marginTop: 2, display: 'inline-block' }}>
          {truthBadgeLabel}
        </div>
      )}
    </div>
  );
}

function areEqual(prev: Props, next: Props): boolean {
  return (
    prev.group === next.group &&
    prev.ci === next.ci &&
    prev.sid === next.sid &&
    prev.date === next.date &&
    prev.timezone === next.timezone &&
    prev.isPast === next.isPast &&
    prev.isToday === next.isToday &&
    prev.sched.isBlockCancelled === next.sched.isBlockCancelled &&
    prev.sched.getSessionSubstitute === next.sched.getSessionSubstitute &&
    prev.sched.getWeekSession === next.sched.getWeekSession &&
    prev.sched.groupColors === next.sched.groupColors &&
    prev.sched.sessionStatuses === next.sched.sessionStatuses &&
    prev.slotTime === next.slotTime &&
    prev.layout === next.layout
  );
}

export default memo(RoomBlock, areEqual);
