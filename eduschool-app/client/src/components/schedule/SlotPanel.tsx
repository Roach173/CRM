import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import toast from 'react-hot-toast';
import type { UseSchedule } from '../../hooks/useSchedule';
import { weekKey, weekDates, formatLocalIso, dateKey } from '../../hooks/useSchedule';
import type { SchedGroup } from './scheduleTypes';
import { relatedBlockIdsOf, DAYS_FULL } from './scheduleTypes';
import api from '../../lib/api';
import { C } from './scheduleTheme';
import { matchesStudentQuery } from '../../utils/scheduleUtils';
import CreateGroupForm from './CreateGroupForm';
import GroupRow from './GroupRow';
import { SlotPanelHeader } from './SlotPanelHeader';
import { SlotPanelFooter } from './SlotPanelFooter';
import { useSlotPanelResize } from './useSlotPanelResize';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useBodyScrollLock } from '../../hooks/useBodyScrollLock';
import { useBackButtonClose } from '../../hooks/useBackButtonClose';
import ConfirmModal from '../ui/ConfirmModal';
import SearchInput from '../ui/SearchInput';

type Teacher = { id: number; firstName: string; lastName: string };
type Cabinet = { id: number; name: string; capacity: number };

interface Props {
  sched: UseSchedule;
  ci: number;
  sid: number;
  viewWk?: string;
  onClose: () => void;
  teachers?: Teacher[];
  cabinets?: Cabinet[];
  onReload?: () => void;
  showSlotAsLabel?: boolean;
  roomName?: string;
  readOnly?: boolean;
  isTeacher?: boolean;
  selectedGid?: number;
  activeDays?: number[];
  timezone?: string;
  initialCreateMode?: boolean;
  isHistoricalPolicy?: boolean;
  initialEditGroupId?: number;
  editGroupCurrentDate?: string;
  policyTimeSlots?: import('./scheduleTypes').TimeSlot[];
  policyConflictBlockId?: number;
  focusGroupOnly?: boolean;
}

export default function SlotPanel({
  sched, ci, sid, viewWk, onClose,
  teachers = [], cabinets = [], onReload,
  showSlotAsLabel, roomName, selectedGid, activeDays: activeDaysProp,
  timezone = 'Asia/Bishkek', initialCreateMode = false, isHistoricalPolicy = false, isTeacher = false,
  initialEditGroupId, editGroupCurrentDate, policyTimeSlots, policyConflictBlockId, focusGroupOnly = false,
  readOnly = false,
}: Props) {
  const activeDays = activeDaysProp ?? sched.aDays;
  const wk = viewWk ?? weekKey(new Date(), timezone);
  const panelSlots = policyTimeSlots ?? sched.slots;
  const editTimeSlots = policyTimeSlots ?? sched.slots.filter(s => !sched.legacySlotIds.includes(s.id));
  const slot = useMemo(() => panelSlots.find(s => s.id === sid), [panelSlots, sid]);
  const slotIsSynthetic = !policyTimeSlots && (sid <= 0 || sched.legacySlotIds.includes(sid));
  const scheduleReadOnlyReason = readOnly
    ? 'Сетка расписания доступна только для просмотра.'
    : !slot
      ? 'Сетка расписания обновилась. Выберите слот заново.'
      : isHistoricalPolicy
        ? 'Историческая сетка доступна только для просмотра.'
        : null;
  const addBlockDisabledReason = scheduleReadOnlyReason
    ?? (slotIsSynthetic ? 'Этот слот не входит в текущую сетку расписания.' : null);
  const allowGroupEditWhenReadOnly = focusGroupOnly && !readOnly && !isHistoricalPolicy;
  const readOnlyBanner = isHistoricalPolicy
    ? 'Вы смотрите историческую сетку расписания. Создание и изменение блоков доступны только в актуальной сетке.'
    : addBlockDisabledReason;
  const cellDate = useMemo(() => weekDates(wk, timezone)[ci], [wk, ci, timezone]);
  // Teacher's own weekly view: a slot only ever holds this one teacher's single
  // lesson, so a per-slot popup always looked like "just one lesson". Teachers
  // instead want the whole day's agenda — every lesson they teach that day —
  // with the clicked one auto-expanded (via selectedGid below).
  const isTeacherDayMode = isTeacher && !roomName && !focusGroupOnly && policyConflictBlockId == null;
  const groupEntries = useMemo(() => {
    const targetGid = selectedGid ?? initialEditGroupId;
    const matchesPolicyTarget = (g: SchedGroup) => {
      if (policyConflictBlockId != null) return relatedBlockIdsOf(g).includes(policyConflictBlockId);
      return targetGid != null && g.id === targetGid;
    };

    if (focusGroupOnly) {
      const exact = Object.values(sched.G).find(matchesPolicyTarget);
      if (!exact) return [];
      const nt = (v: string | undefined) => (v ?? '').slice(0, 5);
      const ownSlot = sched.slots.find(s =>
        nt(s.s) === nt(exact.startTime) && nt(s.e) === nt(exact.endTime),
      );
      return [{
        g: exact,
        sid: ownSlot?.id ?? sid,
        slotStart: exact.startTime ?? ownSlot?.s ?? slot?.s ?? '',
        slotEnd: exact.endTime ?? ownSlot?.e ?? slot?.e ?? '',
      }];
    }

    if (roomName) {
      return panelSlots.flatMap(sl =>
        sched.getGroupsInCell(ci, sl.id, cellDate)
          .filter(g => g.n === roomName)
          .map(g => ({
            g,
            sid: sl.id,
            slotStart: g.startTime ?? sl.s,
            slotEnd: g.endTime ?? sl.e,
          })),
      );
    }

    if (isTeacherDayMode) {
      return panelSlots.flatMap(sl =>
        sched.getGroupsInCell(ci, sl.id, cellDate).map(g => ({
          g,
          sid: sl.id,
          slotStart: g.startTime ?? sl.s,
          slotEnd: g.endTime ?? sl.e,
        })),
      );
    }

    const entries = sched.getGroupsInCell(ci, sid, cellDate).map(g => ({
      g,
      sid,
      slotStart: slot?.s ?? '',
      slotEnd: slot?.e ?? '',
    }));
    if (targetGid && !entries.some(entry => entry.g.id === targetGid)) {
      const selected = sched.G[String(targetGid)];
      if (selected) {
        // Only inject if the group is date-valid for cellDate.
        // Guards against re-injecting a superseded parent block after a split+reload:
        // getGroupsInCell already filtered it out by endDate, so respect that here.
        const dk = dateKey(cellDate);
        const gs = selected.startDate?.slice(0, 10);
        const ge = selected.endDate?.slice(0, 10);
        const beforeEnd = selected.status === 'COMPLETED'
          ? (!ge || dk < ge)
          : (!ge || dk <= ge);
        if ((!gs || dk >= gs) && beforeEnd) {
          const nt = (v: string) => v.slice(0, 5);
          const blockOwnSlot = sched.slots.find(
            s => nt(s.s) === nt(selected.startTime ?? '') && nt(s.e) === nt(selected.endTime ?? ''),
          );
          entries.push({
            g: selected,
            sid: blockOwnSlot?.id ?? sid,
            slotStart: selected.startTime ?? slot?.s ?? '',
            slotEnd: selected.endTime ?? slot?.e ?? '',
          });
        }
      }
    }
    return entries;
  }, [roomName, sched, cellDate, ci, sid, slot, selectedGid, initialEditGroupId, panelSlots, policyConflictBlockId, focusGroupOnly, isTeacherDayMode]);
  const groups = useMemo(() => groupEntries.map(entry => entry.g), [groupEntries]);

  const [newGrpMode, setNewGrpMode] = useState(initialCreateMode);
  const [allExpanded, setAllExpanded] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const [pendingEditGroupId, setPendingEditGroupId] = useState<number | null>(initialEditGroupId ?? null);
  const [stuQuery, setStuQuery] = useState('');
  const [groupPendingRemoval, setGroupPendingRemoval] = useState<SchedGroup | null>(null);
  const [confirmExpandAll, setConfirmExpandAll] = useState(false);

  const handleToggleGroup = useCallback((gid: number) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(gid)) next.delete(gid); else next.add(gid);
      return next;
    });
  }, []);

  useEffect(() => {
    const gid = selectedGid ?? initialEditGroupId;
    if (!gid) return;
    setExpandedIds(prev => {
      if (prev.has(gid)) return prev;
      const next = new Set(prev);
      next.add(gid);
      return next;
    });
  }, [selectedGid, initialEditGroupId]);

  useEffect(() => {
    setPendingEditGroupId(initialEditGroupId ?? null);
  }, [initialEditGroupId]);

  const consumePendingEditGroup = useCallback(() => {
    setPendingEditGroupId(null);
  }, []);

  const handleRemoveGroup = useCallback(async (g: SchedGroup) => {
    try {
      if (g.studentGroupId) {
        await api.delete(`/schedule/group-pair/${g.studentGroupId}`);
      } else {
        // Legacy blocks with no StudentGroup have no backend-enforced pair to delete
        // atomically — fall back to deleting each related block individually.
        for (const id of relatedBlockIdsOf(g)) {
          await api.delete(`/schedule/${id}`);
        }
      }
      onReload?.();
    } catch (err: any) {
      const status = err.response?.status;
      const data = err.response?.data;
      if (status === 409 && data?.error === 'BLOCK_HAS_PAYMENT_HISTORY') {
        toast.error(data.message ?? 'Нельзя удалить блок: по его урокам уже зафиксированы выплаты учителю.');
      } else {
        toast.error(data?.error ?? 'Ошибка удаления');
      }
      onReload?.();
    }
  }, [onReload]);

  const { panelWidth, isDragging, onResizeStart } = useSlotPanelResize(950);
  const isMobile = useIsMobile();

  const cellDateIso = formatLocalIso(cellDate, timezone);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Keeps the page behind the sheet from scrolling. The shared hook is ref-counted,
  // which matters here: the student profile modal opens on top of this panel, and a
  // naive lock would unlock the page when that inner modal closes.
  useBodyScrollLock();
  useBackButtonClose(true, onClose);

  // 350ms to match the app's other debounced searches. Matters here because a
  // settled query force-expands every matching group, and each expand fires one
  // /session/for-date — undebounced that would be a request per keystroke per group.
  const [debouncedQuery, setDebouncedQuery] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(stuQuery), 350);
    return () => clearTimeout(t);
  }, [stuQuery]);

  // Swipe-down-to-close. Only engages on vertical-dominant movement: the schedule
  // grid under this sheet uses horizontal swipes to change days (see index.css
  // overscroll-behavior-x), and stealing those would break day navigation.
  const [dragY, setDragY] = useState(0);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const dragActive = useRef(false);

  const onSheetTouchStart = useCallback((e: React.TouchEvent) => {
    const t = e.touches[0];
    touchStart.current = { x: t.clientX, y: t.clientY };
    dragActive.current = false;
  }, []);
  const onSheetTouchMove = useCallback((e: React.TouchEvent) => {
    if (!touchStart.current) return;
    const t = e.touches[0];
    const dy = t.clientY - touchStart.current.y;
    const dx = t.clientX - touchStart.current.x;
    if (!dragActive.current && (dy < 8 || Math.abs(dx) > Math.abs(dy))) return;
    dragActive.current = true;
    setDragY(Math.max(0, dy));
  }, []);
  const onSheetTouchEnd = useCallback(() => {
    const shouldClose = dragActive.current && dragY > 110;
    touchStart.current = null;
    dragActive.current = false;
    setDragY(0);
    if (shouldClose) onClose();
  }, [dragY, onClose]);

  function applyToggleAll() {
    setAllExpanded(p => {
      const next = !p;
      setExpandedIds(next ? new Set(groups.map(g => g.id)) : new Set());
      return next;
    });
  }

  function toggleAll() {
    // Expanding all isn't just DOM: every group that opens fires its own
    // /session/for-date (see useGroupRowActions), and the endpoint is rate-limited
    // to 30/min. On a big day that's a stall the user didn't ask for.
    if (!allExpanded && groups.length > 12) { setConfirmExpandAll(true); return; }
    applyToggleAll();
  }

  const totalStudents = groups.reduce((s, g) => s + g.stu.length, 0);

  const q = debouncedQuery.trim().toLowerCase();
  const visibleEntries = q
    ? groupEntries.filter(({ g }) => g.stu.some(s => matchesStudentQuery(s, q)))
    : groupEntries;
  // A roster this size can't be scanned by eye, least of all on a phone.
  const showStuSearch = totalStudents > 15;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 200, display: 'flex', alignItems: isMobile ? 'flex-end' : 'center', justifyContent: 'center' }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.5)' }} onClick={onClose} />

      <div style={{
        position: 'relative',
        background: C.bg,
        boxShadow: C.modalShadow,
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        userSelect: isDragging ? 'none' : undefined,
        // Mobile: bottom sheet pinned to the bottom edge — full width, rounded top
        // only, and tall enough that the roster isn't a 3-row peephole.
        ...(isMobile ? {
          width: '100%', maxWidth: '100%', height: '92dvh',
          borderRadius: '16px 16px 0 0', borderTop: `0.5px solid ${C.border}`,
          paddingBottom: 'env(safe-area-inset-bottom)',
        } : {
          width: Math.min(panelWidth, window.innerWidth * 0.97),
          maxWidth: '97vw', maxHeight: '92dvh',
          borderRadius: 12, border: `0.5px solid ${C.border}`,
        }),
        // Only set while actually dragging: a transform on this element would
        // re-root the `position: fixed` kebab menus inside it to this box.
        transform: dragY ? `translateY(${dragY}px)` : undefined,
        transition: dragY ? 'none' : 'transform 0.22s ease',
      }}>
        {/* Resize handle — mouse-only, pointless on touch */}
        {!isMobile && (
          <div
            onMouseDown={onResizeStart}
            style={{ position: 'absolute', top: 0, right: -4, width: 8, height: '100%', cursor: 'ew-resize', zIndex: 10 }}
          />
        )}

        {/* Header — also the swipe-to-close grab area. Deliberately not the body:
            dragging there has to stay plain list scrolling. */}
        <div
          onTouchStart={isMobile ? onSheetTouchStart : undefined}
          onTouchMove={isMobile ? onSheetTouchMove : undefined}
          onTouchEnd={isMobile ? onSheetTouchEnd : undefined}
          style={{ flexShrink: 0 }}
        >
          {isMobile && (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '8px 0 2px' }}>
              <div style={{ width: 40, height: 4, borderRadius: 2, background: C.border }} />
            </div>
          )}
          <SlotPanelHeader
            showSlotAsLabel={showSlotAsLabel || isTeacherDayMode}
            roomName={roomName ?? (isTeacherDayMode
              ? `${DAYS_FULL[ci]}, ${cellDate.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}`
              : undefined)}
            ci={ci}
            slot={slot}
            cellDate={cellDate}
            groupCount={groups.length}
            totalStudents={totalStudents}
            onClose={onClose}
            isMobile={isMobile}
          />
        </div>

        {showStuSearch && (
          <div style={{ padding: isMobile ? '8px 12px' : '8px 20px', borderBottom: `1px solid ${C.borderSoft}`, flexShrink: 0 }}>
            <SearchInput value={stuQuery} onChange={setStuQuery} placeholder="Поиск студента — имя или email" />
          </div>
        )}

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', minHeight: 0, overscrollBehavior: 'contain' }}>
          {groups.length === 0 && !newGrpMode && (
            <div style={{ padding: '40px 0', textAlign: 'center', fontSize: 13, color: C.light }}>
              {isTeacher ? 'В этом слоте нет занятий.' : 'Слот пуст. Добавьте блок расписания.'}
            </div>
          )}

          {q && visibleEntries.length === 0 && groups.length > 0 && (
            <div style={{ padding: '32px 16px', textAlign: 'center', fontSize: 13, color: C.light }}>
              Никто не найден по запросу «{debouncedQuery.trim()}».
            </div>
          )}

          {visibleEntries.map(({ g, sid: entrySid, slotStart, slotEnd }) => (
            <GroupRow
              key={`${g.id}-${entrySid}`}
              group={g} ci={ci} sid={entrySid} sched={sched} wk={wk}
              teachers={teachers} cabinets={cabinets}
              slotStart={slotStart}
              slotEnd={slotEnd}
              activeDays={activeDays}
              timeSlots={editTimeSlots}
              showTimeInsteadOfRoom={Boolean(roomName) || isTeacherDayMode}
              onReload={onReload}
              expanded={q ? true : expandedIds.has(g.id)}
              onToggle={handleToggleGroup}
              onRemoveFromCell={setGroupPendingRemoval}
              studentFilter={debouncedQuery}
              scheduleReadOnly={Boolean(scheduleReadOnlyReason)}
              scheduleReadOnlyReason={scheduleReadOnlyReason ?? undefined}
              allowGroupEditWhenReadOnly={allowGroupEditWhenReadOnly}
              isTeacher={isTeacher}
              isMobile={isMobile}
              autoOpenEditGroup={pendingEditGroupId === g.id}
              editGroupCurrentDate={pendingEditGroupId === g.id ? editGroupCurrentDate : undefined}
              onAutoOpenEditGroupConsumed={consumePendingEditGroup}
            />
          ))}

          {readOnlyBanner && (
            <div style={{ margin: '12px 16px', padding: '10px 12px', borderRadius: 8, background: '#FFF8E1', border: '1px solid #FFE0A3', color: '#7A4B00', fontSize: 12, fontWeight: 600 }}>
              {readOnlyBanner}
            </div>
          )}

          {newGrpMode && !addBlockDisabledReason && (
            <CreateGroupForm
              ci={ci} sid={sid} slot={slot}
              teachers={teachers} cabinets={cabinets}
              activeDays={activeDays} schedGroups={sched.G} slots={sched.slots}
              cellDateIso={cellDateIso}
              onDone={() => { setNewGrpMode(false); onReload?.(); }}
              onCancel={() => setNewGrpMode(false)}
            />
          )}
        </div>

        {/* Footer */}
        <SlotPanelFooter
          isTeacher={isTeacher}
          addBlockDisabledReason={addBlockDisabledReason}
          onAddBlock={() => setNewGrpMode(true)}
          allExpanded={allExpanded}
          onToggleAll={toggleAll}
          isMobile={isMobile}
        />
      </div>

      <ConfirmModal
        isOpen={groupPendingRemoval !== null}
        onClose={() => setGroupPendingRemoval(null)}
        onConfirm={() => { if (groupPendingRemoval) void handleRemoveGroup(groupPendingRemoval); }}
        title={`Удалить группу «${groupPendingRemoval?.lv ?? ''}»?`}
        message="Будущие занятия без посещаемости и выплат будут аннулированы. История посещаемости и начисленные кредиты сохраняются — автоматического возврата кредитов не происходит."
      />

      <ConfirmModal
        isOpen={confirmExpandAll}
        onClose={() => setConfirmExpandAll(false)}
        onConfirm={applyToggleAll}
        isDanger={false}
        confirmText="Развернуть"
        title="Развернуть все группы?"
        message={`Откроется ${groups.length} групп и ${totalStudents} студентов — загрузка займёт время. Быстрее найти нужного студента через поиск.`}
      />
    </div>
  );
}
