/**
 * Phase 6 — Core Security Hardening tests
 *
 * Covers:
 *  - SSRF: static URL validation (private IPs, metadata endpoint, http-only)
 *  - SSRF: DNS rebinding guard (resolveAndBlockPrivate)
 *  - Upload: magic byte validation, SVG rejection, OWNER-only enforcement
 *  - clear-all-data: explicit OWNER role guard, reason validation, env flag
 *  - JWT: getJwtSecret fallback behaviour
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.NODE_ENV = 'test';

// Mock dns/promises so we can control DNS resolution in DNS-rebinding tests
jest.mock('dns/promises', () => ({
  resolve4: jest.fn(),
  resolve6: jest.fn(),
}));

// uuid v14 is ESM-only — provide a CJS-compatible mock so Jest can import upload.ts
jest.mock('uuid', () => ({
  v4: jest.fn(() => `test-${Date.now()}`),
}));

import dns from 'dns/promises';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import type { Server } from 'http';

const { prisma, cleanDb } = require('../helpers/testDb');
const { Role } = require('@prisma/client');

// ── Import security utilities under test ─────────────────────────────────────
import { validateWebhookUrl, resolveAndBlockPrivate, WebhookUrlError } from '../../lib/webhookSecurity';
import { getJwtSecret } from '../../lib/jwtSecret';
import { canClearAllData } from '../../routes/settings';

// ── Test server setup ────────────────────────────────────────────────────────
let server: Server;
let baseUrl: string;

beforeAll((done) => {
  const express = require('express');
  const cookieParser = require('cookie-parser');
  const settingsRoutes = require('../../routes/settings').default;
  const uploadRoutes = require('../../routes/upload').default;
  const { authenticate } = require('../../middleware/authenticate');

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/settings', settingsRoutes);
  app.use('/upload', uploadRoutes);

  server = app.listen(0, () => {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind');
    baseUrl = `http://127.0.0.1:${address.port}`;
    done();
  });
});

beforeEach(async () => {
  (dns.resolve4 as jest.Mock).mockReset();
  (dns.resolve6 as jest.Mock).mockReset();
  await cleanDb();
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err?: Error) => (err ? reject(err) : resolve())),
  );
  await prisma.$disconnect();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function unique(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function createSchool(overrides: Record<string, any> = {}) {
  const id = unique('sec-school');
  return prisma.school.create({
    data: {
      name: 'Security Test School',
      slug: id,
      city: 'Bishkek',
      email: `${id}@test.local`,
      activeDays: [1, 2, 3, 4, 5],
      ...overrides,
    },
  });
}

async function createUser(role: string, overrides: Record<string, any> = {}) {
  const school = overrides.schoolId ? null : await createSchool();
  const id = unique(`sec-${role.toLowerCase()}`);
  const password = await bcrypt.hash('Password123!', 10);
  return prisma.user.create({
    data: {
      schoolId: overrides.schoolId ?? school?.id,
      role,
      firstName: 'Security',
      lastName: 'Test',
      email: `${id}@test.local`,
      password,
      emailVerified: true,
      tokenVersion: 0,
      ...overrides,
    },
  });
}

function signToken(user: any) {
  return jwt.sign(
    { userId: user.id, schoolId: user.schoolId ?? null, role: user.role, tokenVersion: user.tokenVersion },
    process.env.JWT_SECRET!,
    { expiresIn: '7d' },
  );
}

async function request(
  path: string,
  options: { method?: string; body?: unknown; token?: string } = {},
) {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.token) headers.authorization = `Bearer ${options.token}`;

  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

// ── 1. SSRF — static URL validation ─────────────────────────────────────────

describe('SSRF: validateWebhookUrl (static)', () => {
  it('rejects http:// (non-https) in production mode', () => {
    expect(() =>
      validateWebhookUrl('http://example.com/hook', { nodeEnv: 'production' }),
    ).toThrow(WebhookUrlError);
  });

  it('rejects https://localhost in production', () => {
    expect(() =>
      validateWebhookUrl('https://localhost/hook', { nodeEnv: 'production', allowLocalhost: false }),
    ).toThrow(WebhookUrlError);
  });

  it('rejects https://127.0.0.1 (loopback)', () => {
    expect(() => validateWebhookUrl('https://127.0.0.1/hook', { allowLocalhost: false })).toThrow(WebhookUrlError);
  });

  it('rejects https://10.0.0.1 (RFC1918 class A)', () => {
    expect(() => validateWebhookUrl('https://10.0.0.1/hook')).toThrow(WebhookUrlError);
  });

  it('rejects https://192.168.1.100 (RFC1918 class C)', () => {
    expect(() => validateWebhookUrl('https://192.168.1.100/hook')).toThrow(WebhookUrlError);
  });

  it('rejects https://172.20.0.1 (RFC1918 class B)', () => {
    expect(() => validateWebhookUrl('https://172.20.0.1/hook')).toThrow(WebhookUrlError);
  });

  it('rejects https://169.254.169.254 (metadata IP)', () => {
    expect(() => validateWebhookUrl('https://169.254.169.254/metadata')).toThrow(WebhookUrlError);
  });

  it('rejects https://0.0.0.0', () => {
    expect(() => validateWebhookUrl('https://0.0.0.0/hook')).toThrow(WebhookUrlError);
  });

  it('rejects URL with embedded credentials', () => {
    expect(() => validateWebhookUrl('https://user:pass@example.com/hook')).toThrow(WebhookUrlError);
  });

  it('accepts valid https URL', () => {
    const result = validateWebhookUrl('https://hooks.example.com/callback');
    expect(result).toMatch(/^https:\/\//);
  });

  it('strips hash fragment from URL', () => {
    const result = validateWebhookUrl('https://hooks.example.com/callback#anchor');
    expect(result).not.toContain('#anchor');
  });
});

// ── 2. SSRF — DNS rebinding guard ────────────────────────────────────────────

describe('SSRF: resolveAndBlockPrivate (DNS rebinding)', () => {
  it('blocks when hostname resolves to a private IPv4 address', async () => {
    (dns.resolve4 as jest.Mock).mockResolvedValue(['192.168.1.1']);
    (dns.resolve6 as jest.Mock).mockRejectedValue(new Error('ENODATA'));

    await expect(resolveAndBlockPrivate('evil-rebind.example.com')).rejects.toThrow(WebhookUrlError);
    await expect(resolveAndBlockPrivate('evil-rebind.example.com')).rejects.toThrow(/blocked/i);
  });

  it('blocks when hostname resolves to loopback', async () => {
    (dns.resolve4 as jest.Mock).mockResolvedValue(['127.0.0.1']);
    (dns.resolve6 as jest.Mock).mockRejectedValue(new Error('ENODATA'));

    await expect(resolveAndBlockPrivate('sneaky.example.com')).rejects.toThrow(WebhookUrlError);
  });

  it('blocks when hostname resolves to metadata IP 169.254.169.254', async () => {
    (dns.resolve4 as jest.Mock).mockResolvedValue(['169.254.169.254']);
    (dns.resolve6 as jest.Mock).mockRejectedValue(new Error('ENODATA'));

    await expect(resolveAndBlockPrivate('metadata.example.com')).rejects.toThrow(WebhookUrlError);
  });

  it('blocks when DNS resolution completely fails (NXDOMAIN)', async () => {
    (dns.resolve4 as jest.Mock).mockRejectedValue(new Error('ENOTFOUND'));
    (dns.resolve6 as jest.Mock).mockRejectedValue(new Error('ENOTFOUND'));

    await expect(resolveAndBlockPrivate('nonexistent.invalid')).rejects.toThrow(WebhookUrlError);
  });

  it('allows when hostname resolves to a public address', async () => {
    (dns.resolve4 as jest.Mock).mockResolvedValue(['93.184.216.34']); // example.com
    (dns.resolve6 as jest.Mock).mockRejectedValue(new Error('ENODATA'));

    await expect(resolveAndBlockPrivate('example.com')).resolves.toBeUndefined();
  });

  it('skips resolution for direct IPv4 address (already validated at registration)', async () => {
    await expect(resolveAndBlockPrivate('93.184.216.34')).resolves.toBeUndefined();
    expect(dns.resolve4).not.toHaveBeenCalled();
  });
});

// ── 3. Upload: magic bytes + role check ──────────────────────────────────────

describe('Upload: file validation', () => {
  async function uploadRequest(buffer: Buffer, mimetype: string, token?: string) {
    const form = new FormData();
    const blob = new Blob([new Uint8Array(buffer)], { type: mimetype });
    form.append('image', blob, 'test.png');

    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;

    const response = await fetch(`${baseUrl}/upload`, {
      method: 'POST',
      headers,
      body: form,
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }

  it('rejects unauthenticated upload with 401', async () => {
    const buf = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]);
    const res = await uploadRequest(buf, 'image/jpeg');
    expect(res.status).toBe(401);
  });

  it('rejects ADMIN role with 403', async () => {
    const admin = await createUser(Role.ADMIN);
    const token = signToken(admin);
    const buf = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]);
    const res = await uploadRequest(buf, 'image/jpeg', token);
    expect(res.status).toBe(403);
  });

  it('rejects TEACHER role with 403', async () => {
    const teacher = await createUser(Role.TEACHER);
    const token = signToken(teacher);
    const buf = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]);
    const res = await uploadRequest(buf, 'image/jpeg', token);
    expect(res.status).toBe(403);
  });

  it('rejects SVG file regardless of reported MIME type', async () => {
    const owner = await createUser(Role.OWNER);
    const token = signToken(owner);
    const svgContent = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    const buf = Buffer.from(svgContent, 'utf8');
    const res = await uploadRequest(buf, 'image/png', token); // spoofed MIME
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/svg|xml|not allowed/i);
  });

  it('rejects file with invalid magic bytes (not a recognised image format)', async () => {
    const owner = await createUser(Role.OWNER);
    const token = signToken(owner);
    // Random bytes that are not a valid image header
    const buf = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B]);
    const res = await uploadRequest(buf, 'image/jpeg', token);
    expect(res.status).toBe(400);
  });
});

// ── 4. clear-all-data: RBAC + reason + env flag ───────────────────────────────

describe('clear-all-data route', () => {
  it('canClearAllData() returns true in test env (non-production)', () => {
    expect(canClearAllData('test', undefined)).toBe(true);
  });

  it('canClearAllData() returns false in production without flag', () => {
    expect(canClearAllData('production', undefined)).toBe(false);
    expect(canClearAllData('production', 'false')).toBe(false);
  });

  it('canClearAllData() returns true in production when ALLOW_CLEAR_ALL_DATA=true', () => {
    expect(canClearAllData('production', 'true')).toBe(true);
  });

  it('rejects unauthenticated request with 401', async () => {
    const res = await request('/settings/clear-all-data', { method: 'DELETE', body: { reason: 'test' } });
    expect(res.status).toBe(401);
  });

  it('rejects ADMIN role with 403', async () => {
    const admin = await createUser(Role.ADMIN);
    const token = signToken(admin);
    const res = await request('/settings/clear-all-data', {
      method: 'DELETE',
      body: { reason: 'testing clear all data' },
      token,
    });
    expect(res.status).toBe(403);
  });

  it('rejects TEACHER role with 403', async () => {
    const teacher = await createUser(Role.TEACHER);
    const token = signToken(teacher);
    const res = await request('/settings/clear-all-data', {
      method: 'DELETE',
      body: { reason: 'testing clear all data' },
      token,
    });
    expect(res.status).toBe(403);
  });

  it('rejects OWNER with no reason with 400', async () => {
    const owner = await createUser(Role.OWNER);
    const token = signToken(owner);
    const res = await request('/settings/clear-all-data', {
      method: 'DELETE',
      body: {},
      token,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/reason/i);
  });

  it('rejects OWNER with too-short reason with 400', async () => {
    const owner = await createUser(Role.OWNER);
    const token = signToken(owner);
    const res = await request('/settings/clear-all-data', {
      method: 'DELETE',
      body: { reason: 'ok' },
      token,
    });
    expect(res.status).toBe(400);
  });

  it('allows OWNER with valid reason in test env', async () => {
    const owner = await createUser(Role.OWNER);
    const token = signToken(owner);
    const res = await request('/settings/clear-all-data', {
      method: 'DELETE',
      body: { reason: 'Integration test cleanup run' },
      token,
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('closes active memberships so none point to soft-deleted groups after wipe', async () => {
    const owner = await createUser(Role.OWNER);
    const schoolId = owner.schoolId!;
    const studentUser = await createUser(Role.STUDENT, { schoolId });
    const student = await prisma.studentProfile.create({ data: { userId: studentUser.id } });
    const group = await prisma.studentGroup.create({
      data: { schoolId, level: 'A1', chapter: 1, status: 'ACTIVE' },
    });
    await prisma.groupMembership.create({
      data: { schoolId, studentGroupId: group.id, studentProfileId: student.id, status: 'ACTIVE' },
    });

    const res = await request('/settings/clear-all-data', {
      method: 'DELETE',
      body: { reason: 'Integration test cleanup run' },
      token: signToken(owner),
    });
    expect(res.status).toBe(200);

    // Invariant: no ACTIVE membership may point to a soft-deleted group.
    const activeAfter = await prisma.groupMembership.count({ where: { schoolId, status: 'ACTIVE' } });
    expect(activeAfter).toBe(0);
    const orphaned = await prisma.groupMembership.count({
      where: { schoolId, status: 'ACTIVE', studentGroup: { deletedAt: { not: null } } },
    });
    expect(orphaned).toBe(0);
  });
});

// ── 5. getJwtSecret: fallback behaviour ──────────────────────────────────────

describe('getJwtSecret()', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalSecret = process.env.JWT_SECRET;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    process.env.JWT_SECRET = originalSecret;
  });

  it('returns env var when set', () => {
    process.env.JWT_SECRET = 'my-test-secret-32-chars-minimum!!';
    expect(getJwtSecret()).toBe('my-test-secret-32-chars-minimum!!');
  });

  it('returns dev fallback when JWT_SECRET is not set in non-production', () => {
    delete process.env.JWT_SECRET;
    process.env.NODE_ENV = 'development';
    const secret = getJwtSecret();
    expect(secret).toBeTruthy();
    expect(secret).not.toBe('your-secret-key-here');
  });
});
