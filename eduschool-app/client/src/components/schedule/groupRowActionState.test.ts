import { describe, expect, it } from 'vitest';
import { computeGroupRowActionState, type GroupRowActionStateInput } from './groupRowActionState';
import type { SchedStudent } from './scheduleTypes';

function baseInput(overrides: Partial<GroupRowActionStateInput> = {}): GroupRowActionStateInput {
  return {
    group: { status: 'ACTIVE', studentGroupId: 1, stu: [] as SchedStudent[] },
    sessionStatus: 'UPCOMING',
    isMakeup: false,
    isBlockCancelled: false,
    hasLessonStarted: false,
    backendCanEditAttendance: false,
    backendCanReopenAttendance: false,
    scheduleReadOnly: false,
    allowGroupEditWhenReadOnly: false,
    isTeacher: false,
    canDeleteSchedule: true,
    hasCurrentDayConflict: false,
    cancelLoading: false,
    lifecycleLoading: false,
    attSaving: false,
    reopenLoading: false,
    ...overrides,
  };
}

describe('computeGroupRowActionState', () => {
  it('lets an active recurring group be deleted', () => {
    const state = computeGroupRowActionState(baseInput());
    expect(state.canDeleteGroup).toBe(true);
  });

  it('blocks group-pair delete from a cancelled session card', () => {
    const state = computeGroupRowActionState(baseInput({ sessionStatus: 'CANCELLED' }));
    expect(state.isSessionOnlyCard).toBe(true);
    expect(state.canDeleteGroup).toBe(false);
  });

  it('blocks group-pair delete from a makeup session card', () => {
    const state = computeGroupRowActionState(baseInput({ isMakeup: true }));
    expect(state.isSessionOnlyCard).toBe(true);
    expect(state.canDeleteGroup).toBe(false);
  });

  it('blocks restoring an invalidated session when the group is completed', () => {
    const state = computeGroupRowActionState(baseInput({
      sessionStatus: 'INVALIDATED',
      group: { status: 'COMPLETED', studentGroupId: 1, stu: [] },
    }));
    expect(state.isInvalidated).toBe(true);
    expect(state.canRestoreSession).toBe(false);
  });

  it('blocks group delete for a completed group', () => {
    const state = computeGroupRowActionState(baseInput({ group: { status: 'COMPLETED', studentGroupId: 1, stu: [] } }));
    expect(state.canDeleteGroup).toBe(false);
  });

  it('blocks group delete for an archived group', () => {
    const state = computeGroupRowActionState(baseInput({ group: { status: 'ARCHIVED', studentGroupId: 1, stu: [] } }));
    expect(state.canDeleteGroup).toBe(false);
  });

  it('locks group-level actions when scheduleReadOnly is set (backend truth-display: block is not active)', () => {
    // GroupRow.tsx now passes `scheduleReadOnly: scheduleReadOnly || !!group.isReadOnly` —
    // exercising the same input shape the real call site produces for a CLOSED_BY_END_DATE/
    // COMPLETED/CANCELLED block, without needing a new field on this function's input.
    const state = computeGroupRowActionState(baseInput({ scheduleReadOnly: true }));
    expect(state.canEditGroup).toBe(false);
    expect(state.canDeleteGroup).toBe(false);
    expect(state.canPauseGroup).toBe(false);
    expect(state.canCompleteGroup).toBe(false);
    expect(state.canCancelSession).toBe(false);
    // Book/chapter are group-attribute writes, not session/block-level actions — they
    // follow group state, not the read-only display state of a block or historical week.
    expect(state.canBook).toBe(true);
    expect(state.canChapter).toBe(true);
  });

  it('a SOFT_DELETED tombstone card (group.isReadOnly true) has no active actions, view/details only, even though the group itself is still ACTIVE', () => {
    // classifyBlockVisibility() always sets isReadOnly:true for SOFT_DELETED, which
    // GroupRow folds into scheduleReadOnly the same way as any other read-only
    // visibility — same mechanism as the generic case above, named explicitly here
    // since soft-deleted tombstones are the newest and most surprising case. group.status
    // stays 'ACTIVE' (baseInput default) — the tombstone is a block-level fact, not a
    // group-lifecycle one, so isGroupActive alone must never be enough to unlock actions.
    const state = computeGroupRowActionState(baseInput({ scheduleReadOnly: true }));
    expect(state.isGroupActive).toBe(true);
    expect(state.canEditGroup).toBe(false);
    expect(state.canDeleteGroup).toBe(false);
    expect(state.canPauseGroup).toBe(false);
    expect(state.canCompleteGroup).toBe(false);
    expect(state.canCancelSession).toBe(false);
    // Group is still ACTIVE, so book/chapter stay available even on a tombstone card —
    // they are group-attribute writes, unaffected by the block's read-only display.
    expect(state.canBook).toBe(true);
    expect(state.canChapter).toBe(true);
  });

  it('an ACTIVE group with scheduleReadOnly false is unaffected (no regression)', () => {
    const state = computeGroupRowActionState(baseInput());
    expect(state.canEditGroup).toBe(true);
    expect(state.canDeleteGroup).toBe(true);
    expect(state.canPauseGroup).toBe(true);
    expect(state.canCompleteGroup).toBe(true);
    expect(state.canBook).toBe(true);
    expect(state.canChapter).toBe(true);
  });

  it('treats a finalized session as an editable draft with a Save button', () => {
    const state = computeGroupRowActionState(baseInput({
      sessionStatus: 'COMPLETED',
      backendCanReopenAttendance: true,
      group: { status: 'ACTIVE', studentGroupId: 1, stu: [{ id: 1, ta: 'pr' }, { id: 2, ta: 'ab' }] as unknown as SchedStudent[] },
    }));
    expect(state.canEditAttendanceNow).toBe(true);
    expect(state.primaryActionLabel).toBe('Сохранить изменения');
    expect(state.primaryActionDisabled).toBe(false);
  });

  it('blocks saving a finalized session while a student is left unmarked', () => {
    const state = computeGroupRowActionState(baseInput({
      sessionStatus: 'COMPLETED',
      backendCanReopenAttendance: true,
      group: { status: 'ACTIVE', studentGroupId: 1, stu: [{ id: 1, ta: null }, { id: 2, ta: 'ab' }] as unknown as SchedStudent[] },
    }));
    expect(state.unmarkedCount).toBe(1);
    expect(state.primaryActionDisabled).toBe(true);
  });

  it('blocks group-pair delete for a role without schedule:delete (e.g. ADMIN)', () => {
    // Regression: canDeleteGroup used to have zero permission check at all — any
    // non-teacher (including ADMIN, who lacks schedule:delete server-side) saw a
    // live "Удалить из расписания" button that always 403'd.
    const state = computeGroupRowActionState(baseInput({ canDeleteSchedule: false }));
    expect(state.canDeleteGroup).toBe(false);
  });

  it('hides admin-only group lifecycle actions from a teacher', () => {
    const owner = computeGroupRowActionState(baseInput());
    const teacher = computeGroupRowActionState(baseInput({ isTeacher: true }));

    expect(owner.canPauseGroup).toBe(true);
    expect(owner.canCompleteGroup).toBe(true);
    expect(owner.canCancelSession).toBe(true);

    expect(teacher.canPauseGroup).toBe(false);
    expect(teacher.canCompleteGroup).toBe(false);
    expect(teacher.canCancelSession).toBe(false);
  });
});
