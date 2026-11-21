/**
 * D-06: POST /:id/apply cross-tenant guard
 *
 * Verifies that lessonBlock.findFirst includes schoolId: req.user.schoolId in
 * the where clause, preventing a student from school A enrolling in a block
 * that belongs to school B.
 */

// ─── Mock all heavy route dependencies ────────────────────────────────────────

const mockPrisma = {
  studentProfile:    { findFirst: jest.fn() },
  lessonBlock:       { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  enrollmentRequest: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
  user:              { findFirst: jest.fn() },
  lessonSession:     { findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn(), create: jest.fn(), count: jest.fn() },
  attendance:        { findMany: jest.fn() },
  cabinet:           { findMany: jest.fn() },
  timeSlot:          { findMany: jest.fn() },
  studentGroup:      { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  staffProfile:      { findFirst: jest.fn() },
  scheduleActionLog: { create: jest.fn(), findMany: jest.fn() },
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
  decodeCursor:   jest.fn().mockReturnValue(null),
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
jest.mock('../../services/scheduleValidation', () => ({
  ScheduleValidationError:      class extends Error {},
  validateScheduleBlock:         jest.fn().mockResolvedValue(undefined),
  validateSingleSessionOverride: jest.fn().mockResolvedValue(undefined),
  validateSessionTimeBounds:     jest.fn().mockResolvedValue({ valid: true }),
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
  assertCanChangeLevelChapter:   jest.fn().mockResolvedValue(undefined),
  assertGroupOperationallyActive: jest.fn().mockResolvedValue(undefined),
  GroupLifecycleError:           class extends Error {},
  GroupLifecycleService:         jest.fn(),
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
  assertStudentBelongsToSchool:   jest.fn().mockResolvedValue(undefined),
  assertStudentsBelongToSchool:   jest.fn().mockResolvedValue(undefined),
  assertLessonBlockBelongsToSchool: jest.fn().mockResolvedValue(undefined),
  isTenantNotFound:               jest.fn().mockReturnValue(false),
  isPrismaNotFound:               jest.fn().mockReturnValue(false),
}));
jest.mock('../../services/notificationService', () => ({
  createSystemNotification: jest.fn().mockResolvedValue(undefined),
}));

// Inject `req.user` via custom authenticate mock
jest.mock('../../middleware/authenticate', () => ({
  authenticate: (req: any, _res: any, next: any) => {
    req.user = { userId: 100, role: 'STUDENT', schoolId: 1 };
    next();
  },
  AuthRequest: {},
}));
jest.mock('../../middleware/requirePermission', () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));

// ─── Imports (after all jest.mock calls) ──────────────────────────────────────

import express from 'express';
import request from 'supertest';
import scheduleRouter from '../../routes/schedule';
import { notifySchoolAdmins } from '../../lib/notify';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/', scheduleRouter);
  return app;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /:id/apply — D-06 cross-tenant guard', () => {
  const SCHOOL_A_ID   = 1;
  const BLOCK_B_ID    = 99; // block belongs to school B (id=2)
  const STUDENT_PROFILE_ID = 5;

  beforeEach(() => {
    jest.clearAllMocks();
    // Student profile exists in school A
    mockPrisma.studentProfile.findFirst.mockResolvedValue({ id: STUDENT_PROFILE_ID });
  });

  it('block.findFirst where clause includes schoolId (tenant guard present)', async () => {
    // Block is in school B — schoolId filter makes it invisible to school A user
    mockPrisma.lessonBlock.findFirst.mockResolvedValue(null);

    await request(buildApp()).post(`/${BLOCK_B_ID}/apply`);

    expect(mockPrisma.lessonBlock.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ schoolId: SCHOOL_A_ID }),
      }),
    );
  });

  it('cross-tenant block id returns 404', async () => {
    mockPrisma.lessonBlock.findFirst.mockResolvedValue(null);

    const res = await request(buildApp()).post(`/${BLOCK_B_ID}/apply`);

    expect(res.status).toBe(404);
  });

  it('no enrollment request created when block not found (cross-tenant)', async () => {
    mockPrisma.lessonBlock.findFirst.mockResolvedValue(null);

    await request(buildApp()).post(`/${BLOCK_B_ID}/apply`);

    expect(mockPrisma.enrollmentRequest.create).not.toHaveBeenCalled();
    expect(mockPrisma.enrollmentRequest.update).not.toHaveBeenCalled();
  });

  it('no admin notification sent when block not found (cross-tenant)', async () => {
    mockPrisma.lessonBlock.findFirst.mockResolvedValue(null);

    await request(buildApp()).post(`/${BLOCK_B_ID}/apply`);

    expect(notifySchoolAdmins).not.toHaveBeenCalled();
  });
});
