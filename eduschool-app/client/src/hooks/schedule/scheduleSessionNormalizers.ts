import type { MakeupSessionSummary, WeekSessionMeta } from '../../components/schedule/scheduleTypes';
import { sessionKey } from './scheduleKeys';

export interface RawWeekSession {
  lessonBlockId: number; date: string; status: string;
  startTimeSnap: string | null; endTimeSnap: string | null; cabinetIdSnap: number | null;
  teacher: { id: number; firstName: string; lastName: string } | null;
  isSubstitute: boolean;
  isHistoricalTeacher: boolean;
  isManualDate?: boolean;
  dateOverrideFrom?: string | null;
  isMakeup?: boolean;
  makeupForSessionId?: number | null;
  makeupForSession?: MakeupSessionSummary | null;
  makeupSession?: MakeupSessionSummary | null;
  attendanceFinalizedAt?: string | null;
  attendanceFinalizedById?: number | null;
  attendanceFinalizedBy?: { firstName: string; lastName: string } | null;
  attendanceReopenedAt?: string | null;
  attendanceReopenedById?: number | null;
  attendanceReopenedBy?: { firstName: string; lastName: string } | null;
  attendanceReopenReason?: string | null;
  canEditAttendance?: boolean;
  canReopenAttendance?: boolean;
}

export interface WeekSessionMaps {
  subMap: Record<string, WeekSessionMeta>;
  cancMap: Record<string, true>;
  statusMap: Record<string, string>;
}

// Pure transform: GET /schedule/sessions/week response → the three lookup maps
// keyed by `${blockId}_${dateISO}` that useSchedule exposes as weekSessions/
// cancelledSessions/sessionStatuses.
export function buildWeekSessionMaps(sessions: RawWeekSession[]): WeekSessionMaps {
  const subMap: Record<string, WeekSessionMeta> = {};
  const cancMap: Record<string, true> = {};
  const statusMap: Record<string, string> = {};

  for (const s of sessions) {
    // INVALIDATED sessions are kept visible — admin must see and handle them
    const key = sessionKey(s.lessonBlockId, s.date);
    statusMap[key] = s.status;
    const movedFromDate = s.isManualDate && s.dateOverrideFrom && s.dateOverrideFrom !== s.date
      ? s.dateOverrideFrom
      : null;
    const meta: WeekSessionMeta = {
      subTeacherId: s.isSubstitute ? (s.teacher?.id ?? 0) : 0,
      subTeacherName: (s.isSubstitute || s.isHistoricalTeacher) && s.teacher
        ? `${s.teacher.firstName} ${s.teacher.lastName}`.trim()
        : '',
      startTimeSnap: s.startTimeSnap,
      endTimeSnap: s.endTimeSnap,
      cabinetIdSnap: s.cabinetIdSnap,
      isHistoricalTeacher: s.isHistoricalTeacher || false,
      isManualDate: s.isManualDate === true,
      dateOverrideFrom: s.dateOverrideFrom ?? null,
      movedFromDate,
      isMakeup: s.isMakeup || false,
      makeupForSessionId: s.makeupForSessionId ?? null,
      makeupForSession: s.makeupForSession ?? null,
      makeupSession: s.makeupSession ?? null,
      attendanceFinalizedAt: s.attendanceFinalizedAt ?? null,
      attendanceFinalizedById: s.attendanceFinalizedById ?? null,
      attendanceFinalizedBy: s.attendanceFinalizedBy ?? null,
      attendanceReopenedAt: s.attendanceReopenedAt ?? null,
      attendanceReopenedById: s.attendanceReopenedById ?? null,
      attendanceReopenedBy: s.attendanceReopenedBy ?? null,
      attendanceReopenReason: s.attendanceReopenReason ?? null,
      canEditAttendance: s.canEditAttendance === true,
      canReopenAttendance: s.canReopenAttendance === true,
    };
    subMap[key] = meta;
    if (movedFromDate) {
      const sourceKey = sessionKey(s.lessonBlockId, movedFromDate);
      if (!subMap[sourceKey]) {
        subMap[sourceKey] = {
          ...meta,
          movedToDate: s.date,
          movedFromDate,
        };
      }
    }
    if (s.status === 'CANCELLED') {
      cancMap[key] = true;
    }
  }

  return { subMap, cancMap, statusMap };
}
