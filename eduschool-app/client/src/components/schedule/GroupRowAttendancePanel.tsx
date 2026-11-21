import * as GRS from './groupRowStyles';
import { SessionStatusBanner, AttendanceAvailabilityHint } from './GroupRowBadges';

interface GroupRowAttendancePanelProps {
  isLocked: boolean;
  isGroupPaused: boolean;
  isGroupCompleted: boolean;
  isGroupArchived: boolean;
  isInvalidated: boolean;
  isCancelled: boolean;
  noTeacherAssigned: boolean;
  hasCurrentDayConflict: boolean;
  groupDayConflictLabel: string;
  isAttendanceAllowed: boolean;
  hasStudents: boolean;
  primaryLabel: string;
  primaryDisabled: boolean;
  primaryTitle?: string;
  primarySaving: boolean;
  onPrimaryAction: () => void;
}

// Bottom-of-card attendance status banners + the primary submit/reopen/restore
// button. Pure presentational — lifecycle rules live in groupRowActionState.ts,
// this only renders the flags it's given.
export function GroupRowAttendancePanel({
  isLocked, isGroupPaused, isGroupCompleted, isGroupArchived, isInvalidated, isCancelled,
  noTeacherAssigned, hasCurrentDayConflict, groupDayConflictLabel,
  isAttendanceAllowed, hasStudents,
  primaryLabel, primaryDisabled, primaryTitle, primarySaving, onPrimaryAction,
}: GroupRowAttendancePanelProps) {
  return (
    <div style={GRS.attendanceSection}>
      {isLocked && <SessionStatusBanner kind="locked" />}
      {isGroupPaused && <SessionStatusBanner kind="paused" />}
      {isGroupCompleted && <SessionStatusBanner kind="completed" />}
      {isGroupArchived && <SessionStatusBanner kind="archived" />}
      {isInvalidated && <SessionStatusBanner kind="invalidated" />}
      {noTeacherAssigned && !hasCurrentDayConflict && (
        <div style={GRS.noTeacherWarning}>
          <span style={GRS.warningIcon}>⚠</span>
          <span>Учитель не назначен — урок не войдёт в расчёт зарплаты</span>
        </div>
      )}
      {hasCurrentDayConflict && (
        <div style={GRS.noTeacherWarning}>
          <span style={GRS.warningIcon}>!</span>
          <span>Grammar и Club пересекаются по времени: {groupDayConflictLabel}</span>
        </div>
      )}
      {isCancelled && !isGroupArchived && !isGroupCompleted && (
        <SessionStatusBanner kind="cancelled" />
      )}
      {!isAttendanceAllowed && !isLocked && !isGroupPaused && !isGroupCompleted && !isGroupArchived && !isCancelled && !isInvalidated && !hasCurrentDayConflict && hasStudents && (
        <AttendanceAvailabilityHint />
      )}
      <button
        onClick={primaryDisabled ? undefined : onPrimaryAction}
        disabled={primaryDisabled}
        title={primaryTitle}
        style={GRS.submitButton(primaryDisabled, primarySaving)}
      >
        {primaryLabel}
      </button>
    </div>
  );
}
