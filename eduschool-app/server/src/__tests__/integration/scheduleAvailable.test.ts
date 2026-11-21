import express from 'express';
import request from 'supertest';
import {
  prisma,
  cleanDb,
  createSchool,
  createUser,
  createStaffProfile,
  createStudentProfile,
  createGroup,
  createBlock,
  createMembership,
} from '../helpers/testDb';
import scheduleRoutes from '../../routes/schedule';

process.env.NODE_ENV = 'test';

beforeEach(cleanDb);
afterAll(() => prisma.$disconnect());

function buildApp(user: { id: number; schoolId: number | null; role: any; tokenVersion?: number }) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { userId: user.id, schoolId: user.schoolId, role: user.role, tokenVersion: user.tokenVersion ?? 0 };
    next();
  });
  app.use('/api/schedule', scheduleRoutes);
  return app;
}

describe('GET /schedule/available — GroupMembership as the enrollment source of truth', () => {
  it('excludes a group the student already has an ACTIVE GroupMembership in', async () => {
    const school = await createSchool();
    const teacherUser = await createUser(school.id, 'TEACHER');
    const staff = await createStaffProfile(teacherUser.id, school.id);
    const studentUser = await createUser(school.id, 'STUDENT');
    const studentProfile = await createStudentProfile(studentUser.id, school.id);

    const enrolledGroup = await createGroup(school.id);
    const enrolledBlock = await createBlock({ groupId: enrolledGroup.id, schoolId: school.id, staffProfileId: staff.id });
    await createMembership(enrolledGroup.id, studentProfile.id, school.id);

    const eligibleGroup = await createGroup(school.id);
    const eligibleBlock = await createBlock({ groupId: eligibleGroup.id, schoolId: school.id, staffProfileId: staff.id });

    const res = await request(buildApp({ id: studentUser.id, schoolId: school.id, role: 'STUDENT' }))
      .get('/api/schedule/available');

    expect(res.status).toBe(200);
    const ids = res.body.data.map((b: any) => b.id);
    expect(ids).toContain(eligibleBlock.id);
    expect(ids).not.toContain(enrolledBlock.id);
  });

  it('never returns another school\'s blocks, regardless of membership', async () => {
    const school = await createSchool();
    const studentUser = await createUser(school.id, 'STUDENT');
    await createStudentProfile(studentUser.id, school.id);

    const otherSchool = await createSchool();
    const otherTeacherUser = await createUser(otherSchool.id, 'TEACHER');
    const otherStaff = await createStaffProfile(otherTeacherUser.id, otherSchool.id);
    const otherGroup = await createGroup(otherSchool.id);
    const otherBlock = await createBlock({ groupId: otherGroup.id, schoolId: otherSchool.id, staffProfileId: otherStaff.id });

    const res = await request(buildApp({ id: studentUser.id, schoolId: school.id, role: 'STUDENT' }))
      .get('/api/schedule/available');

    expect(res.status).toBe(200);
    expect(res.body.data.map((b: any) => b.id)).not.toContain(otherBlock.id);
  });

  it('reports the real active membership count for a group (regression: was always 0 — read the dead StudentGroup.students relation)', async () => {
    const school = await createSchool();
    const teacherUser = await createUser(school.id, 'TEACHER');
    const staff = await createStaffProfile(teacherUser.id, school.id);
    const studentUser = await createUser(school.id, 'STUDENT');
    await createStudentProfile(studentUser.id, school.id);

    const otherStudentUser = await createUser(school.id, 'STUDENT');
    const otherStudentProfile = await createStudentProfile(otherStudentUser.id, school.id);

    const group = await createGroup(school.id);
    const block = await createBlock({ groupId: group.id, schoolId: school.id, staffProfileId: staff.id });
    await createMembership(group.id, otherStudentProfile.id, school.id); // one active member, not the requester

    const res = await request(buildApp({ id: studentUser.id, schoolId: school.id, role: 'STUDENT' }))
      .get('/api/schedule/available');

    expect(res.status).toBe(200);
    const row = res.body.data.find((b: any) => b.id === block.id);
    expect(row.studentGroup._count.students).toBe(1);
  });

  it('reports the block\'s real level and chapter (regression: mapTeacher() overwrote them with undefined from the id-only studentGroup select)', async () => {
    const school = await createSchool();
    const teacherUser = await createUser(school.id, 'TEACHER');
    const staff = await createStaffProfile(teacherUser.id, school.id);
    const studentUser = await createUser(school.id, 'STUDENT');
    await createStudentProfile(studentUser.id, school.id);

    const group = await createGroup(school.id);
    const block = await createBlock({ groupId: group.id, schoolId: school.id, staffProfileId: staff.id });

    const res = await request(buildApp({ id: studentUser.id, schoolId: school.id, role: 'STUDENT' }))
      .get('/api/schedule/available');

    expect(res.status).toBe(200);
    const row = res.body.data.find((b: any) => b.id === block.id);
    expect(row.level).toBe('A1');
    expect(row.chapter).toBe(1);
  });
});
