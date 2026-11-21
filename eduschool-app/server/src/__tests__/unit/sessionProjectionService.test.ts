/**
 * Unit tests for sessionProjectionService (PR 7).
 *
 * Covers all 8 visibility rules from RFC §9:
 *   SESSION_CANCELLED   — visible, label "Cancelled"
 *   SESSION_RESCHEDULED — visible (represented as CANCELLED + isMakeup=true linked session)
 *   TEACHER_REPLACED    — visible, isSubstitute=true
 *   MAKEUP_CREATED      — visible, sessionType MAKEUP, portalLabel "Makeup class"
 *   MAKEUP_COMPLETED    — visible, label "Completed"
 *   SESSION_INVALIDATED — NOT visible (isVisible=false, filtered from parent view)
 *   SESSION_LOCKED      — visible, label "Completed" (lock is internal)
 *   SESSION_COMPLETED   — visible, label "Completed"
 *
 * Also covers:
 *   - projectSessionsForParent: filters INVALIDATED from list
 *   - DTO shape: all required fields present
 *   - effectiveTeacher resolution: substitute vs block teacher
 */

import { SessionStatus } from '@prisma/client';
import {
  isVisibleToParent,
  projectSessionForParent,
  projectSessionsForParent,
  RawSessionForProjection,
  ParentSessionProjection,
} from '../../services/sessionProjectionService';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeSession(overrides: Partial<RawSessionForProjection> = {}): RawSessionForProjection {
  return {
    id: 1,
    status: 'UPCOMING' as SessionStatus,
    date: new Date('2026-06-10T12:00:00.000Z'),
    startTimeSnap: '09:00',
    endTimeSnap: '10:00',
    isMakeup: false,
    makeupForSessionId: null,
    teacherId: null,
    teacherIdSnap: 10,
    isManualTeacher: false,
    teacher: null,
    lessonBlock: {
      type: 'GRAMMAR',
      studentGroup: { level: 'Beginners A1' },
      cabinet: { name: 'Room 1' },
      teacher: { user: { firstName: 'Anna', lastName: 'Smith' } },
    },
    ...overrides,
  };
}

const BASE_DATE = new Date('2026-06-10T12:00:00.000Z');

// ─── isVisibleToParent ────────────────────────────────────────────────────────

describe('isVisibleToParent', () => {
  it('returns true for UPCOMING', () => expect(isVisibleToParent('UPCOMING')).toBe(true));
  it('returns true for IN_PROGRESS', () => expect(isVisibleToParent('IN_PROGRESS')).toBe(true));
  it('returns true for COMPLETED', () => expect(isVisibleToParent('COMPLETED')).toBe(true));
  it('returns true for LOCKED', () => expect(isVisibleToParent('LOCKED')).toBe(true));
  it('returns true for CANCELLED', () => expect(isVisibleToParent('CANCELLED')).toBe(true));
  it('returns FALSE for INVALIDATED', () => expect(isVisibleToParent('INVALIDATED')).toBe(false));
});

// ─── SESSION_CANCELLED ────────────────────────────────────────────────────────

describe('SESSION_CANCELLED visibility', () => {
  it('is visible to parent', () => {
    const projection = projectSessionForParent(makeSession({ status: 'CANCELLED' }));
    expect(projection.isVisible).toBe(true);
  });

  it('has portalLabel "Cancelled"', () => {
    const projection = projectSessionForParent(makeSession({ status: 'CANCELLED' }));
    expect(projection.portalLabel).toBe('Cancelled');
  });

  it('sets isCancelled=true', () => {
    const projection = projectSessionForParent(makeSession({ status: 'CANCELLED' }));
    expect(projection.isCancelled).toBe(true);
  });

  it('sets parentVisibleReason', () => {
    const projection = projectSessionForParent(makeSession({ status: 'CANCELLED' }));
    expect(projection.parentVisibleReason).toBe('Class cancelled by school');
  });
});

// ─── SESSION_INVALIDATED ─────────────────────────────────────────────────────

describe('SESSION_INVALIDATED hidden from parent', () => {
  it('isVisible is false', () => {
    const projection = projectSessionForParent(makeSession({ status: 'INVALIDATED' }));
    expect(projection.isVisible).toBe(false);
  });

  it('projectSessionsForParent filters out INVALIDATED sessions', () => {
    const sessions = [
      makeSession({ id: 1, status: 'UPCOMING' }),
      makeSession({ id: 2, status: 'INVALIDATED' }),
      makeSession({ id: 3, status: 'COMPLETED' }),
    ];
    const projected = projectSessionsForParent(sessions);
    expect(projected).toHaveLength(2);
    expect(projected.map(p => p.sessionId)).toEqual([1, 3]);
    expect(projected.every(p => p.status !== 'INVALIDATED')).toBe(true);
  });
});

// ─── SESSION_LOCKED ───────────────────────────────────────────────────────────

describe('SESSION_LOCKED visible as Completed', () => {
  it('is visible to parent', () => {
    const projection = projectSessionForParent(makeSession({ status: 'LOCKED' }));
    expect(projection.isVisible).toBe(true);
  });

  it('portalLabel is "Completed" — lock is internal', () => {
    const projection = projectSessionForParent(makeSession({ status: 'LOCKED' }));
    expect(projection.portalLabel).toBe('Completed');
  });

  it('status field still reflects LOCKED internally', () => {
    const projection = projectSessionForParent(makeSession({ status: 'LOCKED' }));
    expect(projection.status).toBe('LOCKED');
  });
});

// ─── SESSION_COMPLETED ────────────────────────────────────────────────────────

describe('SESSION_COMPLETED visible', () => {
  it('is visible, portalLabel "Completed"', () => {
    const projection = projectSessionForParent(makeSession({ status: 'COMPLETED' }));
    expect(projection.isVisible).toBe(true);
    expect(projection.portalLabel).toBe('Completed');
  });

  it('isCancelled is false', () => {
    const projection = projectSessionForParent(makeSession({ status: 'COMPLETED' }));
    expect(projection.isCancelled).toBe(false);
  });
});

// ─── TEACHER_REPLACED visible ─────────────────────────────────────────────────

describe('TEACHER_REPLACED visibility', () => {
  const substituteTeacher = { user: { firstName: 'Bob', lastName: 'Jones' } };

  it('is visible to parent', () => {
    const projection = projectSessionForParent(
      makeSession({ teacherId: 99, isManualTeacher: true, teacher: substituteTeacher })
    );
    expect(projection.isVisible).toBe(true);
  });

  it('isSubstitute is true when isManualTeacher=true', () => {
    const projection = projectSessionForParent(
      makeSession({ teacherId: 99, isManualTeacher: true, teacher: substituteTeacher })
    );
    expect(projection.isSubstitute).toBe(true);
  });

  it('effectiveTeacher resolves to the substitute', () => {
    const projection = projectSessionForParent(
      makeSession({ teacherId: 99, isManualTeacher: true, teacher: substituteTeacher })
    );
    expect(projection.effectiveTeacher).toEqual({ firstName: 'Bob', lastName: 'Jones' });
  });

  it('isSubstitute is false when isManualTeacher=false', () => {
    const projection = projectSessionForParent(makeSession({ isManualTeacher: false }));
    expect(projection.isSubstitute).toBe(false);
  });
});

// ─── MAKEUP_CREATED visible ───────────────────────────────────────────────────

describe('MAKEUP_CREATED visible', () => {
  it('is visible to parent', () => {
    const projection = projectSessionForParent(
      makeSession({ isMakeup: true, makeupForSessionId: 42, status: 'UPCOMING' })
    );
    expect(projection.isVisible).toBe(true);
  });

  it('sessionType is MAKEUP', () => {
    const projection = projectSessionForParent(
      makeSession({ isMakeup: true, makeupForSessionId: 42, status: 'UPCOMING' })
    );
    expect(projection.sessionType).toBe('MAKEUP');
  });

  it('portalLabel is "Makeup class" for upcoming makeup', () => {
    const projection = projectSessionForParent(
      makeSession({ isMakeup: true, makeupForSessionId: 42, status: 'UPCOMING' })
    );
    expect(projection.portalLabel).toBe('Makeup class');
  });

  it('originalSessionId links to the cancelled session', () => {
    const projection = projectSessionForParent(
      makeSession({ isMakeup: true, makeupForSessionId: 42, status: 'UPCOMING' })
    );
    expect(projection.originalSessionId).toBe(42);
  });

  it('isMakeup is true on projection', () => {
    const projection = projectSessionForParent(
      makeSession({ isMakeup: true, makeupForSessionId: 42 })
    );
    expect(projection.isMakeup).toBe(true);
  });
});

// ─── MAKEUP_COMPLETED visible ─────────────────────────────────────────────────

describe('MAKEUP_COMPLETED visible', () => {
  it('makeup session with COMPLETED status is visible', () => {
    const projection = projectSessionForParent(
      makeSession({ isMakeup: true, makeupForSessionId: 42, status: 'COMPLETED' })
    );
    expect(projection.isVisible).toBe(true);
    expect(projection.portalLabel).toBe('Completed');
    expect(projection.sessionType).toBe('MAKEUP');
  });
});

// ─── effectiveTeacher resolution ─────────────────────────────────────────────

describe('effectiveTeacher resolution', () => {
  it('falls back to block teacher when no substitute', () => {
    const session = makeSession({
      teacherId: null,
      isManualTeacher: false,
      teacher: null,
      lessonBlock: {
        type: 'GRAMMAR',
        studentGroup: { level: 'A1' },
        cabinet: null,
        teacher: { user: { firstName: 'Anna', lastName: 'Smith' } },
      },
    });
    const projection = projectSessionForParent(session);
    expect(projection.effectiveTeacher).toEqual({ firstName: 'Anna', lastName: 'Smith' });
    expect(projection.isSubstitute).toBe(false);
  });

  it('returns null effectiveTeacher when neither substitute nor block teacher is set', () => {
    const session = makeSession({
      teacherId: null,
      isManualTeacher: false,
      teacher: null,
      lessonBlock: {
        type: 'GRAMMAR',
        studentGroup: null,
        cabinet: null,
        teacher: null,
      },
    });
    const projection = projectSessionForParent(session);
    expect(projection.effectiveTeacher).toBeNull();
  });

  it('prefers substitute over block teacher', () => {
    const session = makeSession({
      teacherId: 99,
      isManualTeacher: true,
      teacher: { user: { firstName: 'Bob', lastName: 'Jones' } },
      lessonBlock: {
        type: 'GRAMMAR',
        studentGroup: { level: 'A1' },
        cabinet: null,
        teacher: { user: { firstName: 'Anna', lastName: 'Smith' } },
      },
    });
    const projection = projectSessionForParent(session);
    expect(projection.effectiveTeacher).toEqual({ firstName: 'Bob', lastName: 'Jones' });
    expect(projection.isSubstitute).toBe(true);
  });
});

// ─── DTO shape ────────────────────────────────────────────────────────────────

describe('ParentSessionProjection DTO shape', () => {
  it('contains all required fields', () => {
    const projection = projectSessionForParent(makeSession());

    expect(projection).toMatchObject({
      sessionId:          expect.any(Number),
      status:             expect.any(String),
      isVisible:          expect.any(Boolean),
      sessionType:        expect.stringMatching(/^(REGULAR|MAKEUP)$/),
      title:              expect.any(String),
      portalLabel:        expect.any(String),
      date:               expect.any(Date),
      isCancelled:        expect.any(Boolean),
      isMakeup:           expect.any(Boolean),
      isSubstitute:       expect.any(Boolean),
    });

    expect('startTime' in projection).toBe(true);
    expect('endTime' in projection).toBe(true);
    expect('originalSessionId' in projection).toBe(true);
    expect('effectiveTeacher' in projection).toBe(true);
    expect('parentVisibleReason' in projection).toBe(true);
  });

  it('title is "GRAMMAR · Beginners A1" from block type and group name', () => {
    const projection = projectSessionForParent(makeSession());
    expect(projection.title).toBe('GRAMMAR · Beginners A1');
  });

  it('title falls back to "Lesson" when no block data', () => {
    const session = makeSession({ lessonBlock: null });
    expect(projectSessionForParent(session).title).toBe('Lesson');
  });

  it('sessionType is REGULAR for non-makeup session', () => {
    const projection = projectSessionForParent(makeSession({ isMakeup: false }));
    expect(projection.sessionType).toBe('REGULAR');
  });

  it('startTime and endTime are passed through from snap fields', () => {
    const projection = projectSessionForParent(makeSession({ startTimeSnap: '10:00', endTimeSnap: '11:00' }));
    expect(projection.startTime).toBe('10:00');
    expect(projection.endTime).toBe('11:00');
  });

  it('parentVisibleReason is null for non-cancelled sessions', () => {
    const projection = projectSessionForParent(makeSession({ status: 'UPCOMING' }));
    expect(projection.parentVisibleReason).toBeNull();
  });
});

// ─── projectSessionsForParent: batch filter ──────────────────────────────────

describe('projectSessionsForParent', () => {
  it('returns empty array for empty input', () => {
    expect(projectSessionsForParent([])).toEqual([]);
  });

  it('keeps all visible sessions when none are INVALIDATED', () => {
    const sessions = [
      makeSession({ id: 1, status: 'UPCOMING' }),
      makeSession({ id: 2, status: 'COMPLETED' }),
      makeSession({ id: 3, status: 'CANCELLED' }),
      makeSession({ id: 4, status: 'LOCKED' }),
    ];
    expect(projectSessionsForParent(sessions)).toHaveLength(4);
  });

  it('filters out all INVALIDATED sessions from a mixed list', () => {
    const sessions = [
      makeSession({ id: 1, status: 'UPCOMING' }),
      makeSession({ id: 2, status: 'INVALIDATED' }),
      makeSession({ id: 3, status: 'INVALIDATED' }),
      makeSession({ id: 4, status: 'COMPLETED' }),
    ];
    const result = projectSessionsForParent(sessions);
    expect(result).toHaveLength(2);
    expect(result.map(p => p.sessionId)).toEqual([1, 4]);
  });

  it('returns ParentSessionProjection objects with isVisible=true', () => {
    const sessions = [makeSession({ id: 1 })];
    const result = projectSessionsForParent(sessions);
    expect(result[0].isVisible).toBe(true);
  });
});
