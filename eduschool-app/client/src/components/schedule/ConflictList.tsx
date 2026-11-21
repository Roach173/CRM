import React from 'react';
import type { ScheduleConflict } from '../../utils/scheduleConflicts';
import { C } from './scheduleTheme';

interface ConflictListProps {
  conflicts: ScheduleConflict[];
  style?: React.CSSProperties;
}

type ConflictGroupKey = 'cabinet' | 'teacher' | 'student-group' | 'capacity' | 'other';

const CONFLICT_GROUPS: Array<{ key: ConflictGroupKey; title: string; guidance: string }> = [
  { key: 'cabinet', title: 'Кабинет занят', guidance: 'Выберите другой кабинет или другое время.' },
  { key: 'teacher', title: 'Учитель занят', guidance: 'Выберите другого преподавателя или другое время.' },
  { key: 'student-group', title: 'Группа занята', guidance: 'Уберите пересекающийся день или выберите другое время.' },
  { key: 'capacity', title: 'Вместимость', guidance: 'Уменьшите количество студентов или увеличьте лимит группы.' },
  { key: 'other', title: 'Другое', guidance: 'Проверьте параметры расписания и попробуйте снова.' },
];

function groupMeta(type: ConflictGroupKey) {
  return CONFLICT_GROUPS.find(g => g.key === type) ?? CONFLICT_GROUPS[CONFLICT_GROUPS.length - 1];
}

export function classifyConflictMessage(message: string): ConflictGroupKey {
  const m = message.toLowerCase();
  if (m.includes('кабинет')) return 'cabinet';
  if (m.includes('учитель') || m.includes('преподавател')) return 'teacher';
  if (m.includes('вмест') || m.includes('мест') || m.includes('перегруз')) return 'capacity';
  if (m.includes('группа') || m.includes('студент')) return 'student-group';
  return 'other';
}

export function conflictGuidanceFor(typeOrMessage: ConflictGroupKey | string) {
  const key = CONFLICT_GROUPS.some(g => g.key === typeOrMessage)
    ? typeOrMessage as ConflictGroupKey
    : classifyConflictMessage(typeOrMessage);
  return groupMeta(key);
}

// "Учитель занят" messages embed the teacher's name (see scheduleValidation.ts);
// match it back to an id so the conflict modal can deep-link to their profile.
export function findTeacherIdInMessage(
  message: string,
  teachers: Array<{ id: number; firstName: string; lastName: string }>,
): number | null {
  const found = teachers.find(t => message.includes(`${t.firstName} ${t.lastName}`));
  return found ? found.id : null;
}

// Owner's staff list lives at .../owner/staff, admin's at .../admin/teachers —
// both open the teacher card via ?openStaffId=.
export function teacherCardPath(pathname: string, teacherId: number): string {
  const target = pathname.includes('/admin/') ? '/teachers' : '/staff';
  return `${pathname.replace(/\/schedule$/, target)}?openStaffId=${teacherId}`;
}

function conflictTone(conflicts: ScheduleConflict[]) {
  const severity = conflicts.some(c => c.severity === 'critical')
    ? 'critical'
    : conflicts.some(c => c.severity === 'warning')
      ? 'warning'
      : 'info';
  if (severity === 'critical') {
    return { icon: '⛔', bg: C.redLight, border: '#EF9A9A', color: C.red };
  }
  if (severity === 'warning') {
    return { icon: '⚠', bg: '#FFF8E1', border: '#FFD54F', color: C.orange };
  }
  return { icon: 'ℹ', bg: '#E3F2FD', border: '#90CAF9', color: '#1565C0' };
}

function displayGroupFor(c: ScheduleConflict): ConflictGroupKey {
  if (c.type === 'intra-day') return 'student-group';
  if (c.type === 'cabinet' || c.type === 'teacher' || c.type === 'student-group' || c.type === 'capacity') {
    return c.type;
  }
  return 'other';
}

export default function ConflictList({ conflicts, style }: ConflictListProps) {
  if (!conflicts.length) return null;

  const grouped = CONFLICT_GROUPS.map(group => ({
    ...group,
    conflicts: conflicts.filter(c => displayGroupFor(c) === group.key),
  })).filter(group => group.conflicts.length > 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, ...style }}>
      {grouped.map(group => {
        const tone = conflictTone(group.conflicts);
        return (
          <div key={group.key} style={{ borderRadius: 7, border: `1px solid ${tone.border}`, background: tone.bg, overflow: 'hidden' }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '5px 8px 3px', color: tone.color }}>
              <span style={{ flexShrink: 0, fontSize: 11 }}>{tone.icon}</span>
              <span style={{ fontSize: 11, fontWeight: 800 }}>{group.title}</span>
            </div>
            <div style={{ padding: '0 8px 5px 24px', color: tone.color, fontSize: 10, lineHeight: 1.35 }}>
              {group.guidance}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '0 8px 7px 24px' }}>
              {group.conflicts.map((c, i) => (
                <div key={i} style={{ fontSize: 11, color: tone.color, lineHeight: 1.35 }}>
                  {c.message}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
