/**
 * D-02: PATCH /session/:id/details — validateSessionTimeBounds gate
 *
 * Verifies that time edits are rejected when they fall outside School.workStart/workEnd,
 * and that exact boundaries are allowed.
 *
 * Strategy: mock validateSessionTimeBounds at the service level and verify
 * the route correctly propagates its result before calling lessonSession.update.
 */

// ─── Mock all route dependencies (same pattern as d06CrossTenantEnrollment) ───

const mockPrisma = {
  lessonSession: {
    findFirst: jest.fn(),
    update:    jest.fn(),
    findMany:  jest.fn(),
    count:     jest.fn(),
    create:    jest.fn(),
  },
  cabinet:           { findUnique: jest.fn(), findMany: jest.fn() },
  scheduleActionLog: { create: jest.fn(), findMany: jest.fn() },
  lessonBlock:       { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  studentProfile:    { findFirst: jest.fn() },
  enrollmentRequest: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
  user:              { findFirst: jest.fn() },
  attendance:        { findMany: jest.fn() },
  timeSlot:          { findMany: jest.fn() },
  studentGroup:      { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  staffProfile:      { findFirst: jest.fn() },
  $transaction:      jest.fn(async (fn: any) => fn(mockPrisma)),
} as any;

jest.mock('../../lib/prisma', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../lib/socket', () => ({
  emitToSchool: jest.fn(),
  emitScheduleSessionChanged: jest.fn(),
}));
jest.mock('../../lib/notify', () => ({
  notifyMany:         jest.fn().mockResolvedValue(undefined),
  notifySchoolAdmins: jest.fn().mockResolvedValue(undefined),
  notify:             jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../lib/logger', () => ({
  createLogger: () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));
jest.mock('../../lib/cache', () => ({
  cacheGet:        jest.fn().mockResolvedValue(null),
  cacheSet:        jest.fn().mockResolvedValue(undefined),
  cacheInvalidate: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../lib/pagination', () => ({
  decodeCursor:    jest.fn().mockReturnValue(null),
  buildCursorPage: jest.fn().mockReturnValue({ data: [], meta: {} }),
}));
jest.mock('../../lib/cacheKeys', () => ({ CacheKeys: {} }));
jest.mock('../../lib/auditLog', () => ({ logScheduleAction: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../lib/tzUtils', () => ({
  getWeekBoundaries: jest.fn(),
  getDayBoundaries:  jest.fn(),
  dateInTz:          jest.fn(),
}));
jest.mock('../../middleware/rateLimiters', () => ({
  attendanceLimiter:    (_req: any, _res: any, next: any) => next(),
  sessionEnsureLimiter: (_req: any, _res: any, next: any) => next(),
}));
jest.mock('../../middleware/idempotency', () => ({
  idempotency: () => (_req: any, _res: any, next: any) => next(),
}));
jest.mock('../../lib/sessionStateMachine', () => ({
  canTransition: jest.fn().mockReturnValue({ allowed: true }),
}));

const mockValidateSessionTimeBounds = jest.fn();

jest.mock('../../services/scheduleValidation', () => ({
  ScheduleValidationError:       class extends Error {},
  validateScheduleBlock:         jest.fn().mockResolvedValue(undefined),
  validateSingleSessionOverride: jest.fn().mockResolvedValue(undefined),
  validateSessionTimeBounds:     mockValidateSessionTimeBounds,
  checkTeacherWorkload:          jest.fn().mockResolvedValue(undefined),
  daysOverlap:                   jest.fn().mockReturnValue(false),
  timeRangesOverlap:             jest.fn().mockReturnValue(false),
  dateRangesOverlap:             jest.fn().mockReturnValue(false),
}));
jest.mock('../../services/sessionService', () => ({
  syncSessionsForBlock:         jest.fn().mockResolvedValue(undefined),
  cleanupInvalidSessions:       jest.fn().mockResolvedValue(undefined),
  snapshotNewSessions:          jest.fn().mockResolvedValue(undefined),
  extendAllBlockSessions:       jest.fn().mockResolvedValue(undefined),
  ensureSingleSession:          jest.fn().mockResolvedValue({}),
  getEffectiveSessionTeacherId: jest.fn().mockReturnValue(null),
  validateSessionDate:          jest.fn().mockResolvedValue({ valid: true }),
}));
jest.mock('../../services/attendanceService', () => ({ markAttendance: jest.fn() }));
jest.mock('../../services/blockArchiveService', () => ({ archiveLessonBlock: jest.fn() }));
jest.mock('../../services/scheduleLifecycleService', () => ({
  changeSessionStatus:  jest.fn(),
  cancelSession:        jest.fn(),
  restoreSession:       jest.fn(),
  replaceTeacher:       jest.fn(),
  rescheduleSession:    jest.fn(),
  createMakeupSession:  jest.fn(),
  moveSession:          jest.fn(),
}));
jest.mock('../../services/groupLifecycleService', () => ({
  assertCanChangeLevelChapter:    jest.fn().mockResolvedValue(undefined),
  assertGroupOperationallyActive: jest.fn().mockResolvedValue(undefined),
  GroupLifecycleError:            class extends Error {},
  GroupLifecycleService:          jest.fn(),
}));
jest.mock('../../lib/groupLifecyclePolicy', () => ({
  canPerformGroupAction: jest.fn().mockReturnValue({ allowed: true }),
  assertGroupAction:     jest.fn().mockReturnValue(undefined),
}));
jest.mock('../../lib/blockStateMachine', () => ({
  canBlockTransition: jest.fn().mockReturnValue({ allowed: true }),
  BlockStatus:        {},
}));
jest.mock('../../services/consistencyCheckService', () => ({
  runChecks: jest.fn().mockResolvedValue([]),
}));
jest.mock('../../lib/tenant', () => ({
  assertStudentBelongsToSchool:     jest.fn().mockResolvedValue(undefined),
  assertStudentsBelongToSchool:     jest.fn().mockResolvedValue(undefined),
  assertLessonBlockBelongsToSchool: jest.fn().mockResolvedValue(undefined),
  isTenantNotFound:                 jest.fn().mockReturnValue(false),
  isPrismaNotFound:                 jest.fn().mockReturnValue(false),
}));
jest.mock('../../services/notificationService', () => ({
  createSystemNotification: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../middleware/authenticate', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 100, role: 'ADMIN', schoolId: 1 };
    next();
  },
  AuthRequest: {},
}));
jest.mock('../../middleware/requirePermission', () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));

// ─── Imports (after jest.mock calls) ──────────────────────────────────────────

import express from 'express';
import request from 'supertest';
import scheduleRouter from '../../routes/schedule';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/', scheduleRouter);
  return app;
}

const SCHOOL_ID  = 1;
const SESSION_ID = 42;

function makeSessionRow(overrides: Record<string, any> = {}) {
  return {
    id:            SESSION_ID,
    schoolId:      SCHOOL_ID,
    lessonBlockId: 10,
    version:       2,
    status:        'UPCOMING',
    date:          new Date('2026-06-15'),
    startTimeSnap: '09:00',
    endTimeSnap:   '10:30',
    cabinetIdSnap: 5,
    teacherId:     null,
    teacherIdSnap: null,
    isManualTeacher: false,
    lessonBlock: {
      startTime: '09:00',
      endTime:   '10:30',
      cabinetId: 5,
      teacherId: null,
      studentGroupId: 3,
    },
    teacher: null,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('PATCH /session/:id/details — D-02 validateSessionTimeBounds gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.lessonSession.findFirst.mockResolvedValue(makeSessionRow());
    mockPrisma.lessonSession.update.mockResolvedValue(makeSessionRow());
    mockPrisma.cabinet.findUnique.mockResolvedValue({ name: 'Room 1' });
  });

  it('allows update when times are within working hours (boundary exact)', async () => {
    mockValidateSessionTimeBounds.mockResolvedValue({ valid: true });

    const res = await request(buildApp())
      .patch(`/session/${SESSION_ID}/details`)
      .send({ startTime: '08:00', endTime: '20:00', cabinetId: 5, version: 2 });

    expect(res.status).not.toBe(422);
    expect(mockPrisma.lessonSession.update).toHaveBeenCalled();
  });

  it('rejects update when startTime is before workStart (422)', async () => {
    mockValidateSessionTimeBounds.mockResolvedValue({
      valid: false,
      reason: 'Start time 07:30 is before school work start 08:00',
    });

    const res = await request(buildApp())
      .patch(`/session/${SESSION_ID}/details`)
      .send({ startTime: '07:30', endTime: '09:00', cabinetId: 5, version: 2 });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('TIME_OUTSIDE_WORKING_HOURS');
    expect(mockPrisma.lessonSession.update).not.toHaveBeenCalled();
  });

  it('rejects update when endTime is after workEnd (422)', async () => {
    mockValidateSessionTimeBounds.mockResolvedValue({
      valid: false,
      reason: 'End time 21:00 is after school work end 20:00',
    });

    const res = await request(buildApp())
      .patch(`/session/${SESSION_ID}/details`)
      .send({ startTime: '09:00', endTime: '21:00', cabinetId: 5, version: 2 });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('TIME_OUTSIDE_WORKING_HOURS');
    expect(mockPrisma.lessonSession.update).not.toHaveBeenCalled();
  });

  it('does NOT call validateSessionTimeBounds when only cabinetId is changed (no time change)', async () => {
    const res = await request(buildApp())
      .patch(`/session/${SESSION_ID}/details`)
      .send({ cabinetId: 7, version: 2 });

    // Time validation skipped — only cabinet changed
    expect(mockValidateSessionTimeBounds).not.toHaveBeenCalled();
    expect(res.status).not.toBe(422);
  });
});
