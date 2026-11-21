import { Modal, ModalBody, ModalContent, ModalDescription, ModalHeader, ModalTitle } from '../../../components/ui/Modal';
import PolicyConflictsPanel, { type PolicyConflictAction } from '../../../components/schedule/PolicyConflictsPanel';
import type { SchedView } from '../../../components/schedule/scheduleTypes';

interface ScheduleControlModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  description: string;
  auditRefreshKey: number;
  onAction: (action: PolicyConflictAction) => void;
  onConflictState: (hasConflicts: boolean) => void;
}

// Operational Control modal — policy conflicts audit. Pure shell around
// PolicyConflictsPanel; the conflict-resolution logic (onAction) stays in
// Schedule.tsx since it reaches into slotPanel/viewWk/reloadSchedule.
export function ScheduleControlModal({
  open, onOpenChange, description, auditRefreshKey, onAction, onConflictState,
}: ScheduleControlModalProps) {
  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="max-h-[88vh] max-w-4xl dark:bg-card" showClose>
        <ModalHeader className="border-b border-border pb-4 pr-14">
          <ModalTitle>Операционный контроль</ModalTitle>
          <ModalDescription>{description}</ModalDescription>
        </ModalHeader>
        <ModalBody className="max-h-[calc(88vh-96px)] overflow-y-auto p-4 sm:p-5 space-y-4">
          {open && (
            <PolicyConflictsPanel
              refreshKey={auditRefreshKey}
              className="mb-0"
              onAction={onAction}
              onConflictState={onConflictState}
            />
          )}
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}

interface ScheduleSettingsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  view: SchedView;
  persistView: (v: SchedView) => void;
  viewOptions: Array<{ value: SchedView; label: string }>;
  isCurrentWk: boolean;
  weekLabelText: string;
  onPrevWeek: () => void;
  onNextWeek: () => void;
  onToday: () => void;
  teacherFilter: string;
  onTeacherFilterChange: (v: string) => void;
  groupFilter: string;
  onGroupFilterChange: (v: string) => void;
  allTeachers: string[];
  allGroups: Array<{ id: number; name: string }>;
  hasActiveFilters: boolean;
  onResetFilters: () => void;
  inactiveBtnClass: string;
}

// Schedule "gear" settings modal — view switcher, mobile week nav, filters.
// Pure presentational shell; all state (view/filters/week) stays in Schedule.tsx.
export function ScheduleSettingsModal({
  open, onOpenChange, view, persistView, viewOptions,
  isCurrentWk, weekLabelText, onPrevWeek, onNextWeek, onToday,
  teacherFilter, onTeacherFilterChange, groupFilter, onGroupFilterChange,
  allTeachers, allGroups, hasActiveFilters, onResetFilters, inactiveBtnClass,
}: ScheduleSettingsModalProps) {
  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="max-h-[88vh] dark:bg-card" showClose>
        <ModalHeader className="border-b border-border pb-4 pr-14">
          <ModalTitle>Настройки расписания</ModalTitle>
        </ModalHeader>
        <ModalBody className="max-h-[calc(88vh-80px)] space-y-5 overflow-y-auto p-4 sm:p-5">
          {/* Вид расписания */}
          <section>
            <h3 className="m-0 mb-2 text-sm font-bold text-textPrimary">Вид расписания</h3>
            <div className="grid grid-cols-2 gap-2">
              {viewOptions.map(opt => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => persistView(opt.value)}
                  className={`h-11 rounded border px-3 text-sm font-medium transition-colors ${
                    view === opt.value
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border bg-white text-textPrimary hover:bg-surface dark:bg-card'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </section>

          {/* Навигация по неделям — mobile-only fallback; на десктопе степпер живёт в тулбаре.
              Только для week view: у month/rooms/teacher тулбар виден и на мобильном. */}
          {view === 'week' && (
            <section className="lg:hidden">
              <h3 className="m-0 mb-2 text-sm font-bold text-textPrimary">Неделя</h3>
              <div className="flex items-center gap-2">
                <button type="button" className={inactiveBtnClass} onClick={onPrevWeek}>‹</button>
                <div className={`flex-1 text-center text-sm font-semibold ${isCurrentWk ? 'text-primary' : 'text-textPrimary'}`}>
                  {weekLabelText}
                </div>
                <button type="button" className={inactiveBtnClass} onClick={onNextWeek}>›</button>
              </div>
              {!isCurrentWk && (
                <button
                  type="button"
                  onClick={onToday}
                  className="mt-2 h-9 w-full rounded border border-primary/30 bg-white text-sm font-semibold text-primary transition-colors hover:bg-primary/10 dark:bg-card"
                >
                  Сегодня
                </button>
              )}
            </section>
          )}

          {/* Фильтры */}
          {view !== 'month' && view !== 'teacher-availability' && (
            <section className="space-y-3">
              <h3 className="m-0 text-sm font-bold text-textPrimary">Фильтры</h3>
              {view !== 'teacher' && (
                <div>
                  <label className="mb-1 block text-xs text-textSecondary">Учитель</label>
                  <select
                    value={teacherFilter}
                    onChange={e => onTeacherFilterChange(e.target.value)}
                    className="h-10 w-full px-3 text-sm border border-border rounded bg-white text-textPrimary outline-none focus:outline-none cursor-pointer dark:bg-card"
                  >
                    <option value="">Все учителя</option>
                    {allTeachers.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
              )}
              <div>
                <label className="mb-1 block text-xs text-textSecondary">Группа</label>
                <select
                  value={groupFilter}
                  onChange={e => onGroupFilterChange(e.target.value)}
                  className="h-10 w-full px-3 text-sm border border-border rounded bg-white text-textPrimary outline-none focus:outline-none cursor-pointer dark:bg-card"
                >
                  <option value="">Все группы</option>
                  {allGroups.map(g => (
                    <option key={g.id} value={String(g.id)}>{g.name}</option>
                  ))}
                </select>
              </div>
              {hasActiveFilters && (
                <button
                  type="button"
                  onClick={onResetFilters}
                  className="h-9 w-full rounded border border-border bg-white text-sm font-medium text-textSecondary transition-colors hover:bg-surface hover:text-textPrimary dark:bg-card"
                >
                  Сбросить фильтры
                </button>
              )}
            </section>
          )}
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}
