import type { Server } from 'http';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'google-client-id';
process.env.NODE_ENV = 'test';

const mockVerifyIdToken = jest.fn();

jest.mock('google-auth-library', () => ({
  OAuth2Client: jest.fn().mockImplementation(() => ({
    verifyIdToken: mockVerifyIdToken,
  })),
}));

const { prisma, cleanDb } = require('../helpers/testDb');
const { Role } = require('@prisma/client');

let server: Server;
let baseUrl: string;

beforeAll((done) => {
  const express = require('express');
  const cookieParser = require('cookie-parser');
  const authRoutes = require('../../routes/auth').default;
  const usersRoutes = require('../../routes/users').default;
  const invitesRoutes = require('../../routes/invites').default;
  const { authenticate } = require('../../middleware/authenticate');

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.get('/protected', authenticate, (req: any, res: any) => {
    res.json({ success: true, data: req.user });
  });
  app.use('/auth', authRoutes);
  app.use('/users', usersRoutes);
  app.use('/invites', invitesRoutes);

  server = app.listen(0, () => {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind to a port');
    baseUrl = `http://127.0.0.1:${address.port}`;
    done();
  });
});

beforeEach(async () => {
  mockVerifyIdToken.mockReset();
  await cleanDb();
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error?: Error) => (error ? reject(error) : resolve()));
  });
  await prisma.$disconnect();
});

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function createSchoolFixture(overrides: Record<string, any> = {}) {
  const id = unique('auth-school');
  return prisma.school.create({
    data: {
      name: 'Auth School',
      slug: id,
      city: 'Bishkek',
      email: `${id}@test.local`,
      activeDays: [1, 2, 3, 4, 5],
      ...overrides,
    },
  });
}

async function createUserFixture(overrides: Record<string, any> = {}) {
  const school = overrides.schoolId === undefined ? await createSchoolFixture() : null;
  const role = overrides.role ?? Role.OWNER;
  const rawPassword = overrides.rawPassword ?? 'Password123!';
  const password = overrides.password ?? await bcrypt.hash(rawPassword, 10);
  const id = unique(`auth-${String(role).toLowerCase()}`);

  const user = await prisma.user.create({
    data: {
      schoolId: overrides.schoolId ?? school?.id ?? null,
      role,
      firstName: overrides.firstName ?? 'Auth',
      lastName: overrides.lastName ?? 'User',
      email: overrides.email ?? `${id}@test.local`,
      password,
      emailVerified: overrides.emailVerified ?? true,
      tokenVersion: overrides.tokenVersion ?? 0,
      deletedAt: overrides.deletedAt,
    },
    include: { school: true },
  });

  return { user, school: user.school, rawPassword };
}

function signAccess(user: any, overrides: Record<string, any> = {}) {
  return jwt.sign(
    {
      userId: user.id,
      schoolId: user.schoolId ?? null,
      role: user.role,
      tokenVersion: user.tokenVersion,
      ...overrides,
    },
    process.env.JWT_SECRET!,
    { expiresIn: '7d' },
  );
}

async function requestJson(
  path: string,
  options: { method?: string; body?: unknown; token?: string; cookie?: string } = {},
) {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.cookie) headers.cookie = options.cookie;

  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
    setCookie: response.headers.get('set-cookie'),
  };
}

describe('Auth hardening', () => {
  it('rejects stale JWT after password change', async () => {
    const { user } = await createUserFixture();
    const token = signAccess(user);

    await prisma.user.update({
      where: { id: user.id },
      data: { tokenVersion: { increment: 1 } },
    });

    const res = await requestJson('/protected', { token });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Session expired');
  });

  it('rejects stale JWT after role change', async () => {
    const { user } = await createUserFixture({ role: Role.ADMIN });
    const token = signAccess(user);

    await prisma.user.update({
      where: { id: user.id },
      data: { role: Role.STUDENT, tokenVersion: { increment: 1 } },
    });

    const res = await requestJson('/protected', { token });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Session expired');
  });

  it('rejects JWT for soft-deleted users', async () => {
    const { user } = await createUserFixture();
    const token = signAccess(user);

    await prisma.user.update({
      where: { id: user.id },
      data: { deletedAt: new Date(), tokenVersion: { increment: 1 } },
    });

    const res = await requestJson('/protected', { token });
    expect(res.status).toBe(401);
  });

  it('rejects users from schools blocked beyond grace window', async () => {
    const school = await createSchoolFixture({
      blockedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
    });
    const { user } = await createUserFixture({ schoolId: school.id });
    const token = signAccess(user);

    const res = await requestJson('/protected', { token });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('School access blocked');
  });

  it('detects refresh token reuse outside grace window and revokes active sessions', async () => {
    const { user } = await createUserFixture();
    const reusedToken = 'reused-refresh-token';
    const activeToken = 'active-refresh-token';

    await prisma.refreshToken.create({
      data: {
        token: reusedToken,
        userId: user.id,
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: new Date(Date.now() - 6_000),
      },
    });
    await prisma.refreshToken.create({
      data: {
        token: activeToken,
        userId: user.id,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const res = await requestJson('/auth/refresh', { method: 'POST', cookie: `rt=${reusedToken}` });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Refresh token reuse detected');

    const active = await prisma.refreshToken.findUnique({ where: { token: activeToken } });
    expect(active?.revokedAt).toBeInstanceOf(Date);
  });

  it('rotates refresh tokens and returns a fresh access token', async () => {
    const { user } = await createUserFixture();
    const oldToken = 'old-refresh-token';
    await prisma.refreshToken.create({
      data: {
        token: oldToken,
        userId: user.id,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const res = await requestJson('/auth/refresh', { method: 'POST', cookie: `rt=${oldToken}` });
    expect(res.status).toBe(200);
    expect(res.body.data.token).toBeTruthy();
    expect(res.setCookie).toContain('rt=');

    const oldStored = await prisma.refreshToken.findUnique({ where: { token: oldToken } });
    const activeCount = await prisma.refreshToken.count({
      where: { userId: user.id, revokedAt: null },
    });
    expect(oldStored?.revokedAt).toBeInstanceOf(Date);
    expect(activeCount).toBe(1);
  });

  it('blocks role escalation when creating users', async () => {
    const { user } = await createUserFixture({ role: Role.OWNER });
    const token = signAccess(user);

    const res = await requestJson('/users', {
      method: 'POST',
      token,
      body: {
        firstName: 'New',
        lastName: 'Owner',
        email: `${unique('new-owner')}@test.local`,
        password: 'Password123!',
        role: Role.OWNER,
      },
    });

    expect(res.status).toBe(403);
  });

  it('smoke: logs in with school slug and logs out', async () => {
    const { user, school, rawPassword } = await createUserFixture();

    const loginRes = await requestJson('/auth/login', {
      method: 'POST',
      body: { email: user.email, password: rawPassword, slug: school.slug },
    });
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.data.token).toBeTruthy();
    expect(loginRes.body.data.school.slug).toBe(school.slug);
    expect(loginRes.setCookie).toContain('rt=');

    const cookie = loginRes.setCookie?.split(';')[0];
    const logoutRes = await requestJson('/auth/logout', { method: 'POST', cookie });
    expect(logoutRes.status).toBe(200);
  });

  it('rejects Google OAuth access_token payloads', async () => {
    const res = await requestJson('/auth/google', {
      method: 'POST',
      body: { token: 'old-access-token', context: 'login' },
    });

    expect(res.status).toBe(400);
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
  });

  it('accepts Google OAuth id_token credentials', async () => {
    const email = `${unique('oauth')}@test.local`;
    await createUserFixture({ email });
    mockVerifyIdToken.mockResolvedValue({
      getPayload: () => ({
        aud: process.env.GOOGLE_CLIENT_ID,
        iss: 'https://accounts.google.com',
        exp: Math.floor(Date.now() / 1000) + 300,
        email_verified: true,
        email,
        given_name: 'Google',
        family_name: 'User',
      }),
    });

    const res = await requestJson('/auth/google', {
      method: 'POST',
      body: { credential: 'valid-id-token', context: 'login' },
    });

    expect(res.status).toBe(200);
    expect(res.body.data.token).toBeTruthy();
    expect(res.setCookie).toContain('rt=');
    expect(mockVerifyIdToken).toHaveBeenCalledWith({
      idToken: 'valid-id-token',
      audience: process.env.GOOGLE_CLIENT_ID,
    });
  });

  it('smoke: registers a new school through Google OAuth and returns onboarding state', async () => {
    const email = `${unique('oauth-register')}@test.local`;
    mockVerifyIdToken.mockResolvedValue({
      getPayload: () => ({
        aud: process.env.GOOGLE_CLIENT_ID,
        iss: 'accounts.google.com',
        exp: Math.floor(Date.now() / 1000) + 300,
        email_verified: true,
        email,
        given_name: 'Owner',
        family_name: 'Google',
      }),
    });

    const res = await requestJson('/auth/google', {
      method: 'POST',
      body: { credential: 'register-id-token', context: 'register-school' },
    });

    expect(res.status).toBe(200);
    expect(res.body.data.user.role).toBe(Role.OWNER);
    expect(res.body.data.school.slug).toBeTruthy();
    expect(res.body.data.school.onboardingCompleted).toBe(false);
    expect(res.setCookie).toContain('rt=');
  });

  it('smoke: accepts an invite and issues a tokenVersioned session', async () => {
    const school = await createSchoolFixture();
    const inviteToken = 'invite-smoke-token';
    const email = `${unique('invitee')}@test.local`;

    await prisma.staffInvite.create({
      data: {
        schoolId: school.id,
        email,
        role: Role.TEACHER,
        firstName: 'Invited',
        lastName: 'Teacher',
        tokenHash: crypto.createHash('sha256').update(inviteToken).digest('hex'),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const res = await requestJson('/invites/accept', {
      method: 'POST',
      body: {
        token: inviteToken,
        firstName: 'Invited',
        lastName: 'Teacher',
        password: 'Password123!',
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.data.user.role).toBe(Role.TEACHER);
    expect(res.body.data.school.slug).toBe(school.slug);
    const decoded = jwt.decode(res.body.data.token) as any;
    expect(decoded.tokenVersion).toBe(0);
    expect(res.setCookie).toContain('rt=');
  });

  it('smoke: logs in without a slug when the identifier is globally unique', async () => {
    const { user, rawPassword } = await createUserFixture();

    const res = await requestJson('/auth/login', {
      method: 'POST',
      body: { email: user.email, password: rawPassword },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.token).toBeTruthy();
  });

  it('rejects slug-less login when the identifier collides across schools', async () => {
    const sharedEmail = `${unique('shared')}@test.local`;
    const { rawPassword: passwordA } = await createUserFixture({ email: sharedEmail });
    await createUserFixture({ email: sharedEmail });

    const res = await requestJson('/auth/login', {
      method: 'POST',
      body: { email: sharedEmail, password: passwordA },
    });
    expect(res.status).toBe(409);
  });

  it('rate limits repeated login attempts', async () => {
    let lastStatus = 0;
    for (let i = 0; i < 11; i++) {
      const res = await requestJson('/auth/login', {
        method: 'POST',
        body: { email: `${unique('missing-login')}@test.local`, password: 'wrong' },
      });
      lastStatus = res.status;
    }

    expect(lastStatus).toBe(429);
  });
});
