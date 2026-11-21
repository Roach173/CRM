/**
 * Integration: Tenant Isolation — Schedule routes & validator
 *
 * Regression guard for the cross-school leak fixed in the schedule domain:
 * teacher (StaffProfile) and cabinet lookups that took a client-supplied id
 * without a schoolId scope. A user from School A must not be able to attach or
 * read School B's teacher/cabinet.
 *
 * Runs against a real PostgreSQL database (see .env.test).
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.NODE_ENV = 'test';

import type { Server } from 'http';
import jwt from 'jsonwebtoken';

import {
  prisma,
  cleanDb,
  createSchool,
  createUser,
  createStaffProfile,
} from '../helpers/testDb';

import { validateScheduleBlock, ScheduleValidationError } from '../../services/scheduleValidation';

beforeEach(cleanDb);
afterAll(() => prisma.$disconnect());

function createCabinet(schoolId: number, name: string, capacity = 10) {
  return prisma.cabinet.create({ data: { schoolId, name, capacity } });
}

// ─── Validator: cabinet scoping ───────────────────────────────────────────────
// validateScheduleBlock is the shared choke point for block create/edit. A
// cabinet from another school must be rejected, not silently used.

describe('validateScheduleBlock — cabinet tenant scoping', () => {
  function blockParams(schoolId: number, cabinetId: number) {
    return {
      schoolId,
      cabinetId,
      teacherId: null,
      startTime: '09:00',
      endTime: '10:00',
      days: [0],
      startDate: new Date('2026-06-01T12:00:00.000Z'),
      endDate: null,
      maxStudents: 10,
      studentGroupId: null,
      blockType: 'SPEAKING_CLUB', // allows a null teacher, keeps the test focused on the cabinet
    };
  }

  it('accepts a cabinet that belongs to the requesting school', async () => {
    const schoolA = await createSchool();
    const cabinetA = await createCabinet(schoolA.id, 'Cab A');

    await expect(
      validateScheduleBlock(prisma, blockParams(schoolA.id, cabinetA.id)),
    ).resolves.toBe(true);
  });

  it('rejects a cabinet that belongs to another school', async () => {
    const schoolA = await createSchool();
    const schoolB = await createSchool();
    const cabinetB = await createCabinet(schoolB.id, 'Cab B');

    // School A context, but School B's cabinet id → must not resolve it.
    await expect(
      validateScheduleBlock(prisma, blockParams(schoolA.id, cabinetB.id)),
    ).rejects.toThrow(ScheduleValidationError);
  });
});

// ─── Handler: teacher read scoping ────────────────────────────────────────────
// GET /teacher-lesson-calendar-admin resolves a StaffProfile from a
// client-supplied ?teacherId (a User id). A foreign teacher must 404, not leak.

describe('GET /teacher-lesson-calendar-admin — teacher tenant scoping', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll((done) => {
    const express = require('express');
    const dashboardRoutes = require('../../routes/schedule/scheduleDashboard.routes').default;

    const app = express();
    app.use(express.json());
    app.use('/schedule', dashboardRoutes);

    server = app.listen(0, () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Test server did not bind');
      baseUrl = `http://127.0.0.1:${address.port}`;
      done();
    });
  });

  afterAll((done) => {
    server.close(() => done());
  });

  function signToken(user: any) {
    return jwt.sign(
      { userId: user.id, schoolId: user.schoolId ?? null, role: user.role, tokenVersion: user.tokenVersion ?? 0 },
      process.env.JWT_SECRET!,
      { expiresIn: '7d' },
    );
  }

  async function getCalendar(teacherUserId: number, token: string) {
    return fetch(
      `${baseUrl}/schedule/teacher-lesson-calendar-admin?year=2026&month=6&teacherId=${teacherUserId}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
  }

  it('404s when an owner requests a teacher from another school', async () => {
    const schoolA = await createSchool();
    const schoolB = await createSchool();

    const ownerA = await createUser(schoolA.id, 'OWNER');
    const teacherUserB = await createUser(schoolB.id, 'TEACHER');
    await createStaffProfile(teacherUserB.id, schoolB.id);

    const res = await getCalendar(teacherUserB.id, signToken(ownerA));
    expect(res.status).toBe(404);
  });

  it('resolves a teacher that belongs to the requesting school', async () => {
    const schoolA = await createSchool();

    const ownerA = await createUser(schoolA.id, 'OWNER');
    const teacherUserA = await createUser(schoolA.id, 'TEACHER');
    await createStaffProfile(teacherUserA.id, schoolA.id);

    const res = await getCalendar(teacherUserA.id, signToken(ownerA));
    expect(res.status).not.toBe(404);
  });
});
