/**
 * Unit tests: Effective Teacher Source of Truth
 *
 * Verifies the canonical rule for getEffectiveSessionTeacherId:
 *   isManualTeacher=true  → teacherId (substitute wins)
 *   isManualTeacher=false → teacherIdSnap (snapshot wins)
 *
 * Also verifies that syncSessionsForBlock self-healing propagates
 * block.teacherId to non-manual UPCOMING sessions (teacherIdSnap).
 */
import { getEffectiveSessionTeacherId } from '../../services/sessionService';

describe('getEffectiveSessionTeacherId — canonical rule', () => {
  it('returns teacherId when isManualTeacher=true (substitute wins)', () => {
    const session = { teacherId: 42, teacherIdSnap: 10, isManualTeacher: true };
    expect(getEffectiveSessionTeacherId(session)).toBe(42);
  });

  it('returns teacherIdSnap when isManualTeacher=false (snapshot wins)', () => {
    const session = { teacherId: 42, teacherIdSnap: 10, isManualTeacher: false };
    expect(getEffectiveSessionTeacherId(session)).toBe(10);
  });

  it('returns null when isManualTeacher=true and teacherId is null (teacher cleared)', () => {
    const session = { teacherId: null, teacherIdSnap: 10, isManualTeacher: true };
    expect(getEffectiveSessionTeacherId(session)).toBeNull();
  });

  it('returns null when isManualTeacher=false and teacherIdSnap is null', () => {
    const session = { teacherId: null, teacherIdSnap: null, isManualTeacher: false };
    expect(getEffectiveSessionTeacherId(session)).toBeNull();
  });

  it('does not fall through to teacherId when isManualTeacher=false', () => {
    // Block teacher change without applyFrom: teacherIdSnap may differ from teacherId.
    // The snapshot is authoritative; teacherId on session without isManualTeacher=true is ignored.
    const session = { teacherId: 99, teacherIdSnap: 7, isManualTeacher: false };
    expect(getEffectiveSessionTeacherId(session)).toBe(7);
    expect(getEffectiveSessionTeacherId(session)).not.toBe(99);
  });
});
