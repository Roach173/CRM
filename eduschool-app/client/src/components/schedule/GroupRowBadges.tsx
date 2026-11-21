import type { CSSProperties, MouseEvent } from 'react';
import type { BlockVisibility, SchedGroup } from './scheduleTypes';
import { DAYS_SHORT } from './scheduleTypes';
import { C } from './scheduleTheme';
import * as GRS from './groupRowStyles';

export type AttendanceActor = { firstName: string; lastName: string } | null;

export function formatAttendanceDateTime(value?: string | null) {
  if (!value) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatAttendanceActor(actor?: AttendanceActor, fallbackId?: number | null) {
  if (actor) {
    const name = `${actor.firstName ?? ''} ${actor.lastName ?? ''}`.trim();
    if (name) return name;
  }
  return fallbackId ? `ID ${fallbackId}` : '';
}

export function attLabel(v: null | 'pr' | 'ab') {
  return v === 'pr' ? 'Присутствует' : v === 'ab' ? 'Отсутствует' : 'Не отмечен';
}

export function attBtnStyle(v: null | 'pr' | 'ab', isMobile = false): CSSProperties {
  return {
    padding: '3px 10px', borderRadius: 20, border: '1px solid',
    borderColor: v === 'pr' ? '#639922' : v === 'ab' ? '#E24B4A' : C.border,
    background: v === 'pr' ? C.greenLight : v === 'ab' ? C.redLight : C.bgLight,
    color: v === 'pr' ? C.green : v === 'ab' ? C.red : C.mid,
    fontSize: isMobile ? 12 : 11, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' as const,
    // Fixed width: the pill column stays aligned (header ↔ rows) and toggling
    // a status can't shift the row layout.
    minWidth: 104, textAlign: 'center' as const, boxSizing: 'border-box' as const,
    // Mobile: this is the reason the sheet gets opened at all, so it takes the
    // leftover width of the control row and a real 40px touch height.
    ...(isMobile ? { flex: 1, minHeight: 40 } : { minHeight: 30 }),
  };
}

export function bookBtnStyle(active: boolean, isMobile = false): CSSProperties {
  return {
    padding: isMobile ? '3px 12px' : '3px 8px', borderRadius: 20, border: '1px solid',
    borderColor: active ? '#639922' : C.border,
    background: active ? C.greenLight : C.bgLight,
    color: active ? C.green : C.light,
    fontSize: isMobile ? 12 : 11, fontWeight: 600, cursor: 'pointer', flexShrink: 0,
    minHeight: isMobile ? 40 : 30,
  };
}

export function parsePd(pd: string) {
  if (!pd) return null;
  const p = pd.split('.');
  if (p.length !== 3) return null;
  const d = new Date(`${p[2]}-${p[1]}-${p[0]}`);
  if (isNaN(d.getTime())) return null;
  const now = new Date();
  const diff = d.getTime() - now.getTime();
  const color = diff < 0 ? '#E24B4A' : diff < 7 * 86400000 ? '#EF9F27' : C.primary;
  return { text: pd, color };
}

// Single attendance model in the UI: pr / ab / null (see attLabel / attBtnStyle).
// The server enum (PRESENT/ABSENT/LATE) is converted to/from `ta` only here, at
// the API boundary. LATE has no UI slot — it loads as present.
export function dbStatusToTa(status: unknown): 'pr' | 'ab' {
  return status === 'PRESENT' || status === 'LATE' ? 'pr' : 'ab';
}

export function DayBadge({ days, variant, onClick }: {
  days: number[]; variant: 'grammar' | 'club'; onClick: (e: MouseEvent) => void;
}) {
  const text = days.map(d => DAYS_SHORT[d]).join(' ');
  return (
    <span onClick={onClick} style={GRS.dayBadge(variant, days.length > 0)}>
      {text || '—'}
    </span>
  );
}

export function TeacherPill({ name, variant, sub }: {
  name: string; variant: 'grammar' | 'club'; sub?: { subTeacherName: string } | null;
}) {
  const empty = !name || name === '—';
  const label = variant === 'grammar' ? 'Гр' : 'Кл';
  const hasRealSub = !!(sub?.subTeacherName);
  return (
    <div style={GRS.teacherPillContainer}>
      <span style={GRS.teacherPill(variant, empty, hasRealSub)}>
        {empty ? `${variant === 'grammar' ? 'Грамматика' : 'Разг. клуб'}: не назначен` : `${label}: ${name}`}
      </span>
      {sub?.subTeacherName && (
        <span style={GRS.subTeacherPill}>Замена: {sub.subTeacherName}</span>
      )}
    </div>
  );
}

export function GroupStatusBanner({ status, blockVisibility, visibilityReason }: {
  status?: SchedGroup['status'];
  /** Backend truth-display fields — only pass these when no LessonSession governs
   * the currently-displayed date (session facts take priority, see caller). */
  blockVisibility?: BlockVisibility;
  visibilityReason?: string;
}) {
  if (status === 'COMPLETED' || status === 'ARCHIVED') {
    const archived = status === 'ARCHIVED';
    return (
      <div style={{
        margin: '0 0 10px 0',
        padding: '8px 12px',
        borderRadius: 7,
        background: archived ? '#ECEFF1' : '#F5F5F5',
        border: `1px solid ${archived ? '#CFD8DC' : '#E0E0E0'}`,
        fontSize: 11, color: archived ? '#546E7A' : '#757575', lineHeight: 1.5,
      }}>
        {archived
          ? '🗃 Группа архивирована. Расписание и состав недоступны для изменения.'
          : '✓ Группа завершена. Расписание и состав недоступны для изменения.'}
      </div>
    );
  }
  // Block-level truth (this specific LessonBlock is closed/cancelled/completed)
  // wasn't already explained by the group-level banner above — surface it here.
  if (blockVisibility && blockVisibility !== 'ACTIVE') {
    return (
      <div style={{
        margin: '0 0 10px 0',
        padding: '8px 12px',
        borderRadius: 7,
        background: '#F5F5F5',
        border: '1px solid #E0E0E0',
        fontSize: 11, color: '#757575', lineHeight: 1.5,
      }}>
        ℹ {visibilityReason ?? 'Блок неактивен.'} Расписание недоступно для изменения.
      </div>
    );
  }
  return null;
}

export type SessionBannerKind = 'locked' | 'paused' | 'completed' | 'archived' | 'invalidated' | 'cancelled';

export function SessionStatusBanner({ kind }: { kind: SessionBannerKind }) {
  const map: Record<SessionBannerKind, { bg: string; color: string; border?: string; text: string }> = {
    locked: { bg: '#EEF2FF', color: '#3730A3', text: '🔒 Урок зафиксирован — посещаемость закрыта' },
    paused: { bg: C.pausedLight, color: C.paused, text: '⏸ Группа на паузе' },
    completed: { bg: C.bgLight, color: C.mid, text: '✓ Группа завершена' },
    archived: { bg: '#ECEFF1', color: '#546E7A', text: '🗃 Группа архивирована — действия недоступны' },
    invalidated: { bg: '#FCE4EC', color: '#B71C1C', text: '⊘ Урок аннулирован — действия недоступны' },
    cancelled: { bg: '#FFF3CD', color: '#92400E', border: '#FBBF24', text: '⊘ Занятие отменено — посещаемость недоступна' },
  };
  const item = map[kind];
  return (
    <div style={{
      padding: '6px 10px', borderRadius: 6, marginBottom: 6,
      background: item.bg, color: item.color,
      fontSize: 11, fontWeight: 600, textAlign: 'center' as const,
      border: item.border ? `1px solid ${item.border}` : undefined,
    }}>
      {item.text}
    </div>
  );
}

export function AttendanceAvailabilityHint() {
  return (
    <div style={{
      padding: '6px 9px', borderRadius: 6, marginBottom: 6,
      background: '#FFF8E1', color: '#8D6E00',
      fontSize: 10, fontWeight: 600, textAlign: 'center' as const,
      border: '1px solid #FFE08A',
      lineHeight: 1.4,
    }}>
      ⏳ Урок ещё не начат. Для сдачи посещаемости переведите урок в статус «Идёт сейчас» или «Проведён» через меню урока.
    </div>
  );
}
