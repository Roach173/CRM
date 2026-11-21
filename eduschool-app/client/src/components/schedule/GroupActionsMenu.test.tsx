// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { GroupActionsMenu } from './GroupActionsMenu';

// Regression test for a real bug: a teacher's kebab menu on a live session showed
// «Редактировать урок» / «✎ Редактировать группу» / «✕ Удалить из расписания» as
// live, clickable actions — every one of them 403s server-side for TEACHER (see
// permissions.ts: TEACHER has neither schedule:write nor schedule:delete). Every
// sibling admin-only action here (cancel/pause/complete/restore-invalidated) already
// excluded isTeacher; edit-session, edit-group and delete-group did not.
function baseProps(overrides: Partial<Parameters<typeof GroupActionsMenu>[0]> = {}) {
  return {
    top: 0,
    right: 0,
    isInvalidated: false,
    isCancelled: false,
    isTeacher: false,
    isGroupActive: true,
    isGroupPaused: false,
    isGroupCompleted: false,
    isGroupArchived: false,
    scheduleReadOnly: false,
    scheduleReadOnlyReason: undefined,
    scheduleWriteLocked: false,
    canEditGroup: true,
    canDeleteGroup: true,
    canPauseGroup: true,
    canCompleteGroup: true,
    canCancelSession: true,
    canRestoreSession: false,
    canResumeGroup: false,
    cancelLoading: false,
    onEditSession: vi.fn(),
    onCancelSession: vi.fn(),
    onRestoreCancelledSession: vi.fn(),
    onRestoreInvalidatedSession: vi.fn(),
    onEditGroup: vi.fn(),
    onPauseGroup: vi.fn(),
    onResumeGroup: vi.fn(),
    onCompleteGroup: vi.fn(),
    onDeleteFromCell: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

describe('GroupActionsMenu — teacher restrictions on a live session', () => {
  it('owner/admin see full edit/delete actions', () => {
    render(<GroupActionsMenu {...baseProps({ isTeacher: false })} />);
    expect(screen.getByText('📅 Редактировать урок')).toBeInTheDocument();
    expect(screen.getByText('⊘ Отменить занятие')).toBeInTheDocument();
    expect(screen.getByText('✎ Редактировать группу')).toBeInTheDocument();
    expect(screen.getByText('✕ Удалить из расписания')).toBeInTheDocument();
  });

  it('a teacher gets no edit-session, edit-group, or delete actions', () => {
    render(<GroupActionsMenu {...baseProps({ isTeacher: true })} />);
    expect(screen.queryByText('📅 Редактировать урок')).not.toBeInTheDocument();
    expect(screen.queryByText('🔒 Редактировать урок')).not.toBeInTheDocument();
    expect(screen.queryByText('⊘ Отменить занятие')).not.toBeInTheDocument();
    expect(screen.queryByText('✎ Редактировать группу')).not.toBeInTheDocument();
    expect(screen.queryByText('✕ Удалить из расписания')).not.toBeInTheDocument();
    // Still gets a view-only affordance for the group instead of silence.
    expect(screen.getByText('👁 Просмотр группы')).toBeInTheDocument();
  });
});
