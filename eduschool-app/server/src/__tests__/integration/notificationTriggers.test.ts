import type { Server } from 'http';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { Role } from '@prisma/client';
import {
  prisma,
  cleanDb,
  createSchool,
  createUser,
  createStudentProfile,
  createStaffProfile,
  createGroup,
  createBlock,
} from '../helpers/testDb';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.NODE_ENV = 'test';

let server: Server;
let baseUrl: string;

beforeAll((done) => {
  const express = require('express');
  const cookieParser = require('cookie-parser');
  const invitesRoutes = require('../../routes/invites').default;
  const studentsRoutes = require('../../routes/students').default;
  const paymentsRoutes = require('../../routes/payments').default;
  const subscriptionsRoutes = require('../../routes/subscriptions').default;
  const scheduleRoutes = require('../../routes/schedule').default;

  const app = express();
  app.use(cookieParser());
  app.use(express.json());

  app.use('/invites', invitesRoutes);
  app.use('/students', studentsRoutes);
  app.use('/payments', paymentsRoutes);
  app.use('/subscriptions', subscriptionsRoutes);
  app.use('/schedule', scheduleRoutes);

  server = app.listen(0, () => {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind to a port');
    baseUrl = `http://127.0.0.1:${address.port}`;
    done();
  });
});

beforeEach(cleanDb);

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error?: Error) => (error ? reject(error) : resolve()));
  });
  await prisma.$disconnect();
});

function signAccess(user: any) {
  return jwt.sign(
    {
      userId: user.id,
      schoolId: user.schoolId ?? null,
      role: user.role,
      tokenVersion: user.tokenVersion ?? 0,
    },
    process.env.JWT_SECRET!,
    { expiresIn: '7d' }
  );
}

async function requestJson(
  path: string,
  options: { method?: string; body?: unknown; token?: string; headers?: Record<string, string> } = {}
) {
  const headers: Record<string, string> = { ...options.headers };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.token) headers.authorization = `Bearer ${options.token}`;

  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
  };
}

describe('Notification Triggers Integration Tests', () => {
  it('1. Staff invite accepted creates OWNER/ADMIN notifications', async () => {
    const school = await createSchool();
    const ownerUser = await createUser(school.id, 'OWNER');
    const adminUser = await createUser(school.id, 'ADMIN');

    const inviteToken = 'test-staff-invite-token';
    const email = 'new-teacher@test.local';

    const invite = await prisma.staffInvite.create({
      data: {
        schoolId: school.id,
        email,
        role: Role.TEACHER,
        firstName: 'New',
        lastName: 'Teacher',
        tokenHash: crypto.createHash('sha256').update(inviteToken).digest('hex'),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const res = await requestJson('/invites/accept', {
      method: 'POST',
      body: {
        token: inviteToken,
        firstName: 'New',
        lastName: 'Teacher',
        password: 'Password123!',
      },
    });

    expect(res.status).toBe(200);

    // Verify notifications were created for OWNER and ADMIN
    const notifications = await prisma.notification.findMany({
      where: { schoolId: school.id, type: 'STAFF_INVITE_ACCEPTED' },
      orderBy: { userId: 'asc' },
    });

    expect(notifications).toHaveLength(2);
    expect(notifications.map(n => n.userId).sort()).toEqual([ownerUser.id, adminUser.id].sort());
    
    // Check fields
    const ownerNotification = notifications.find(n => n.userId === ownerUser.id);
    expect(ownerNotification?.category).toBe('STAFF');
    expect(ownerNotification?.priority).toBe('NORMAL');
    expect(ownerNotification?.actionUrl).toBe(`/${school.slug}/owner/staff`);

    const adminNotification = notifications.find(n => n.userId === adminUser.id);
    expect(adminNotification?.category).toBe('STAFF');
    expect(adminNotification?.priority).toBe('NORMAL');
    expect(adminNotification?.actionUrl).toBe(`/${school.slug}/admin/teachers`);
  });

  it('2. Student created creates OWNER/ADMIN notifications', async () => {
    const school = await createSchool();
    const ownerUser = await createUser(school.id, 'OWNER');
    const adminUser = await createUser(school.id, 'ADMIN');
    const token = signAccess(ownerUser);

    const res = await requestJson('/students', {
      method: 'POST',
      token,
      body: {
        firstName: 'Ivan',
        lastName: 'Ivanov',
        email: 'ivan@test.local',
        password: 'Password123!',
        level: 'A2',
        chapter: '2',
      },
    });

    expect(res.status).toBe(200);

    const notifications = await prisma.notification.findMany({
      where: { schoolId: school.id, type: 'STUDENT_CREATED' },
    });

    expect(notifications).toHaveLength(2);
    expect(notifications.map(n => n.userId).sort()).toEqual([ownerUser.id, adminUser.id].sort());

    const ownerNotification = notifications.find(n => n.userId === ownerUser.id);
    expect(ownerNotification?.category).toBe('STUDENTS');
    expect(ownerNotification?.actionUrl).toBe(`/${school.slug}/owner/students`);

    const adminNotification = notifications.find(n => n.userId === adminUser.id);
    expect(adminNotification?.category).toBe('STUDENTS');
    expect(adminNotification?.actionUrl).toBe(`/${school.slug}/admin/students`);
  });

  it('3. Finance Payment creation creates notifications (and respects idempotency replay)', async () => {
    const school = await createSchool();
    const ownerUser = await createUser(school.id, 'OWNER');
    const adminUser = await createUser(school.id, 'ADMIN');
    const studentUser = await createUser(school.id, 'STUDENT');
    const studentProfile = await createStudentProfile(studentUser.id, school.id);
    const token = signAccess(ownerUser);

    const idempotencyKey = 'payment-idempotency-key-test';

    // 1st request creates payment and triggers notifications
    const res1 = await requestJson('/payments', {
      method: 'POST',
      token,
      headers: { 'idempotency-key': idempotencyKey },
      body: {
        studentProfileId: studentProfile.id,
        amount: 15000, // HIGH priority >= 10000
        method: 'TRANSFER',
        note: 'High value payment',
      },
    });

    expect(res1.status).toBe(201);

    const notifications = await prisma.notification.findMany({
      where: { schoolId: school.id, type: 'PAYMENT_CREATED' },
    });

    expect(notifications).toHaveLength(2);
    expect(notifications.map(n => n.userId).sort()).toEqual([ownerUser.id, adminUser.id].sort());

    const ownerNotification = notifications.find(n => n.userId === ownerUser.id);
    expect(ownerNotification?.priority).toBe('HIGH');
    expect(ownerNotification?.actionUrl).toBe(`/${school.slug}/owner/finance`);

    // 2nd request is an idempotency replay (should NOT trigger new notifications)
    const res2 = await requestJson('/payments', {
      method: 'POST',
      token,
      headers: { 'idempotency-key': idempotencyKey },
      body: {
        studentProfileId: studentProfile.id,
        amount: 15000,
        method: 'TRANSFER',
        note: 'High value payment',
      },
    });

    expect(res2.status).toBe(201);
    const amt1 = typeof res1.body.data.payment.amount === 'object' ? 15000 : Number(res1.body.data.payment.amount);
    const amt2 = typeof res2.body.data.payment.amount === 'object' ? 15000 : Number(res2.body.data.payment.amount);
    expect(amt2).toBe(amt1);

    const notificationsAfterReplay = await prisma.notification.findMany({
      where: { schoolId: school.id, type: 'PAYMENT_CREATED' },
    });

    expect(notificationsAfterReplay).toHaveLength(2); // Still 2, no duplicates!
  });

  it('4. Quick Student Payment creates notification', async () => {
    const school = await createSchool();
    const ownerUser = await createUser(school.id, 'OWNER');
    const adminUser = await createUser(school.id, 'ADMIN');
    const studentUser = await createUser(school.id, 'STUDENT');
    const studentProfile = await createStudentProfile(studentUser.id, school.id);
    const token = signAccess(ownerUser);

    const res = await requestJson(`/students/${studentUser.id}`, {
      method: 'PATCH',
      token,
      headers: { 'idempotency-key': 'quick-payment-notif-trigger-key' },
      body: {
        paymentAmount: 500, // NORMAL priority
        paymentMethod: 'CASH',
        paymentNote: 'quick pay',
      },
    });

    expect(res.status).toBe(200);

    const notifications = await prisma.notification.findMany({
      where: { schoolId: school.id, type: 'PAYMENT_CREATED' },
    });

    expect(notifications).toHaveLength(2);
    expect(notifications.map(n => n.userId).sort()).toEqual([ownerUser.id, adminUser.id].sort());

    const ownerNotification = notifications.find(n => n.userId === ownerUser.id);
    expect(ownerNotification?.priority).toBe('NORMAL');
    expect(ownerNotification?.title).toContain('быстрая');
  });

  it('5. Subscription status changes create notifications with role-specific action URLs', async () => {
    const school = await createSchool();
    const ownerUser = await createUser(school.id, 'OWNER');
    const adminUser = await createUser(school.id, 'ADMIN');
    const superAdminUser = await prisma.user.create({
      data: {
        role: Role.SUPERADMIN,
        firstName: 'Super',
        lastName: 'Admin',
        email: `superadmin-${Date.now()}@test.local`,
        password: 'hashed',
      },
    });
    const token = signAccess(superAdminUser);

    await prisma.subscription.create({
      data: {
        schoolId: school.id,
        plan: 'STARTER',
        status: 'ACTIVE',
      },
    });

    // Block subscription
    const blockRes = await requestJson(`/subscriptions/${school.id}/block`, {
      method: 'PATCH',
      token,
    });
    expect(blockRes.status).toBe(200);

    const blockNotifications = await prisma.notification.findMany({
      where: { schoolId: school.id, type: 'SUBSCRIPTION_BLOCKED' },
    });
    expect(blockNotifications).toHaveLength(2);

    const ownerBlock = blockNotifications.find(n => n.userId === ownerUser.id);
    expect(ownerBlock?.priority).toBe('CRITICAL');
    expect(ownerBlock?.actionUrl).toBe(`/${school.slug}/owner/dashboard`);

    // Mark paid
    const payRes = await requestJson(`/subscriptions/${school.id}/mark-paid`, {
      method: 'PATCH',
      token,
      body: { days: 30, plan: 'OPTIMA' },
    });
    expect(payRes.status).toBe(200);

    const payNotifications = await prisma.notification.findMany({
      where: { schoolId: school.id, type: 'SUBSCRIPTION_MARK_PAID' },
    });
    expect(payNotifications).toHaveLength(2);

    const adminPay = payNotifications.find(n => n.userId === adminUser.id);
    expect(adminPay?.priority).toBe('HIGH');
    expect(adminPay?.actionUrl).toBe(`/${school.slug}/admin/dashboard`);
  });

  it('6. Teacher assigned to group creates notification for the teacher', async () => {
    const school = await createSchool();
    const ownerUser = await createUser(school.id, 'OWNER');
    const teacherUser = await createUser(school.id, 'TEACHER');
    const teacherProfile = await createStaffProfile(teacherUser.id, school.id);
    const group = await createGroup(school.id);
    const token = signAccess(ownerUser);

    // Pre-create timeSlot
    await prisma.timeSlot.create({
      data: {
        schoolId: school.id,
        startTime: '10:00',
        endTime: '11:00',
        order: 1,
      },
    });

    // Pre-create cabinet
    const cabinet = await prisma.cabinet.create({
      data: {
        schoolId: school.id,
        name: 'Room 1',
        capacity: 15,
      },
    });

    // Create a block with the teacher assigned
    const res = await requestJson('/schedule', {
      method: 'POST',
      token,
      body: {
        startTime: '10:00',
        endTime: '11:00',
        days: [1, 3],
        level: 'A1',
        chapter: 1,
        type: 'GRAMMAR',
        teacherId: teacherUser.id,
        studentGroupId: group.id,
        cabinetId: cabinet.id,
      },
    });

    if (res.status !== 200) {
      console.error('SCHEDULE POST FAILED:', res.body);
    }
    expect(res.status).toBe(200);

    const notifications = await prisma.notification.findMany({
      where: { userId: teacherUser.id, type: 'TEACHER_ASSIGNED_TO_GROUP' },
    });

    expect(notifications).toHaveLength(1);
    expect(notifications[0].category).toBe('SCHEDULE');
    expect(notifications[0].priority).toBe('NORMAL');
    expect(notifications[0].actionUrl).toBe(`/${school.slug}/teacher/schedule`);
  });
});
