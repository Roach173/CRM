// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StudentRow } from './GroupRowStudentRow';
import type { SchedStudent } from './scheduleTypes';
import type { UseSchedule } from '../../hooks/useSchedule';

// Regression test: a teacher's per-student «⋮» menu offered «✕ Удалить из группы»
// with zero permission check — DELETE /groups/:id/students/:id requires schedule:write,
// which TEACHER doesn't have (same bug class as the group-pair delete fix). onToggleBook/
// onChapterDelta were already correctly withheld for teachers by the caller (GroupRow) —
// only this menu was missed.
const stu: SchedStudent = {
  id: 1, n: 'Тест Студент', ph: '', em: '', ch: 1, pd: '', ta: null, st: 'ok', cm: '', lt: 'all', book: false,
};

function renderRow(isTeacher: boolean) {
  return render(
    <StudentRow
      stu={stu}
      gid={1}
      sched={{} as UseSchedule}
      onSelect={vi.fn()}
      selected={false}
      onOpenProfile={vi.fn()}
      attendanceEditable={false}
      paused={false}
      isTeacher={isTeacher}
    />
  );
}

describe('StudentRow — per-student remove menu', () => {
  it('staff (isTeacher=false) sees the «⋮» menu with «Удалить из группы»', () => {
    renderRow(false);
    expect(screen.getByText('⋮')).toBeInTheDocument();
  });

  it('a teacher does not see the «⋮» menu at all', () => {
    renderRow(true);
    expect(screen.queryByText('⋮')).not.toBeInTheDocument();
  });
});
