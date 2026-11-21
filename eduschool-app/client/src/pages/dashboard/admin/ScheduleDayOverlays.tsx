import type { UseSchedule } from '../../../hooks/useSchedule';
import DayAnnotationPopup from '../../../components/schedule/DayAnnotationPopup';
import BulkCancelModal from '../../../components/schedule/BulkCancelModal';
import { DayActionsMenu } from './ScheduleToolbarControls';

interface ScheduleDayOverlaysProps {
  sched: UseSchedule;
  tz: string;
  viewWk: string;
  policyIsHistorical: boolean;
  formatDayLabel: (dateKey: string) => string;

  dayAnnotCtx: string | null;
  restoringDay: boolean;
  onCloseDayAnnot: () => void;
  onCancelDay: (dateKey: string) => void;
  onRestoreDay: (dateKey: string) => void;

  showBulkCancel: boolean;
  bulkCancelInitial: { date: string; label: string } | null;
  onCloseBulkCancel: () => void;

  dayMenuCtx: { dk: string; x: number; y: number } | null;
  onCloseDayMenu: () => void;
  onDayMenuNote: (dateKey: string) => void;
  onDayMenuCancel: (dateKey: string) => void;
  onDayMenuRestore: (dateKey: string) => void;
}

// Bundles the three day-level overlays (annotation popup, bulk-cancel modal,
// day-actions context menu) that Schedule.tsx pops open from WeekGrid/RoomsView/
// MonthView's day headers. Pure presentational — all state and mutation handlers
// (dayAnnotCtx, handleRestoreDay, etc.) still live in Schedule.tsx.
export default function ScheduleDayOverlays({
  sched, tz, viewWk, policyIsHistorical, formatDayLabel,
  dayAnnotCtx, restoringDay, onCloseDayAnnot, onCancelDay, onRestoreDay,
  showBulkCancel, bulkCancelInitial, onCloseBulkCancel,
  dayMenuCtx, onCloseDayMenu, onDayMenuNote, onDayMenuCancel, onDayMenuRestore,
}: ScheduleDayOverlaysProps) {
  const todayISO = new Date().toLocaleDateString('sv-SE', { timeZone: tz });

  return (
    <>
      {dayAnnotCtx && (
        <DayAnnotationPopup
          dateKey={dayAnnotCtx}
          dateLabel={formatDayLabel(dayAnnotCtx)}
          initial={sched.dayNotes[dayAnnotCtx] ?? ''}
          isPast={dayAnnotCtx < todayISO}
          isDayCancelled={Object.keys(sched.cancelledSessions).some(k => k.endsWith(`_${dayAnnotCtx}`))}
          restoring={restoringDay}
          onSave={text => sched.setDayNote(dayAnnotCtx, text)}
          onClose={onCloseDayAnnot}
          onCancelDay={() => onCancelDay(dayAnnotCtx)}
          onRestoreDay={() => onRestoreDay(dayAnnotCtx)}
        />
      )}

      {showBulkCancel && (
        <BulkCancelModal
          open={showBulkCancel}
          viewWk={viewWk}
          activeDays={sched.aDays}
          timezone={tz}
          initialDate={bulkCancelInitial?.date}
          initialLabel={bulkCancelInitial?.label}
          onSuccess={() => sched.loadWeekSessions(viewWk)}
          onClose={onCloseBulkCancel}
        />
      )}

      {dayMenuCtx && (
        <DayActionsMenu
          x={dayMenuCtx.x}
          y={dayMenuCtx.y}
          isPast={dayMenuCtx.dk < todayISO}
          isHistorical={policyIsHistorical}
          isDayCancelled={Object.keys(sched.cancelledSessions).some(k => k.endsWith(`_${dayMenuCtx.dk}`))}
          onNote={() => onDayMenuNote(dayMenuCtx.dk)}
          onCancel={() => onDayMenuCancel(dayMenuCtx.dk)}
          onRestore={() => onDayMenuRestore(dayMenuCtx.dk)}
          onClose={onCloseDayMenu}
        />
      )}
    </>
  );
}
