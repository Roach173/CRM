import express from 'express';
import { AddressInfo } from 'net';
import { Server } from 'http';
import jwt from 'jsonwebtoken';
import { cleanDb, createSchool, createUser, createStaffProfile, createGroup, createBlock, prisma } from '../helpers/testDb';
import settingsRouter from '../../routes/settings';

let server: Server;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/settings', settingsRouter);
  server = app.listen(0, done);
});

beforeEach(cleanDb);

afterAll((done) => {
  server.close(() => {
    prisma.$disconnect().finally(done);
  });
});

function baseUrl() {
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function tokenFor(user: { id: number; role: string }, schoolId: number) {
  return jwt.sign(
    { userId: user.id, schoolId, role: user.role },
    process.env.JWT_SECRET || 'your-secret-key-here'
  );
}

async function requestJson(path: string, token: string, method = 'GET', body?: Record<string, unknown>) {
  const res = await fetch(`${baseUrl()}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
}

async function setup() {
  const school = await createSchool();
  const owner = await createUser(school.id, 'OWNER');
  const token = tokenFor(owner, school.id);
  return { school, owner, token };
}

describe('GET /settings/cabinets — usageCount', () => {
  it('counts only non-deleted blocks per cabinet', async () => {
    const { school, token } = await setup();
    const used = await prisma.cabinet.create({ data: { schoolId: school.id, name: '101', capacity: 12 } });
    const free = await prisma.cabinet.create({ data: { schoolId: school.id, name: '102', capacity: 12 } });

    const teacherUser = await createUser(school.id, 'TEACHER');
    const staff = await createStaffProfile(teacherUser.id, school.id);
    const group = await createGroup(school.id);
    const active = await createBlock({ schoolId: school.id, staffProfileId: staff.id, groupId: group.id });
    const deleted = await createBlock({ schoolId: school.id, staffProfileId: staff.id, groupId: group.id, deletedAt: new Date() });
    await prisma.lessonBlock.update({ where: { id: active.id }, data: { cabinetId: used.id } });
    await prisma.lessonBlock.update({ where: { id: deleted.id }, data: { cabinetId: used.id } });

    const { status, json } = await requestJson('/settings/cabinets', token);
    expect(status).toBe(200);
    const byName = Object.fromEntries(json.data.map((c: any) => [c.name, c.usageCount]));
    expect(byName['101']).toBe(1);
    expect(byName['102']).toBe(0);
    expect(json.data.find((c: any) => c.id === free.id)).toBeTruthy();
  });
});

describe('PATCH /settings/cabinets/:id', () => {
  it('renames and changes capacity', async () => {
    const { school, token } = await setup();
    const cab = await prisma.cabinet.create({ data: { schoolId: school.id, name: '101', capacity: 12 } });

    const { status, json } = await requestJson(`/settings/cabinets/${cab.id}`, token, 'PATCH', { name: '201', capacity: 20 });
    expect(status).toBe(200);
    expect(json.data.name).toBe('201');
    expect(json.data.capacity).toBe(20);

    const inDb = await prisma.cabinet.findUnique({ where: { id: cab.id } });
    expect(inDb?.name).toBe('201');
    expect(inDb?.capacity).toBe(20);
  });

  it('keeps existing values when fields are omitted or invalid', async () => {
    const { school, token } = await setup();
    const cab = await prisma.cabinet.create({ data: { schoolId: school.id, name: '101', capacity: 12 } });

    const { status, json } = await requestJson(`/settings/cabinets/${cab.id}`, token, 'PATCH', { capacity: 'abc' });
    expect(status).toBe(200);
    expect(json.data.name).toBe('101');
    expect(json.data.capacity).toBe(12);
  });

  it('rejects duplicate name and empty name', async () => {
    const { school, token } = await setup();
    await prisma.cabinet.create({ data: { schoolId: school.id, name: '101', capacity: 12 } });
    const cab = await prisma.cabinet.create({ data: { schoolId: school.id, name: '102', capacity: 12 } });

    const dup = await requestJson(`/settings/cabinets/${cab.id}`, token, 'PATCH', { name: '101' });
    expect(dup.status).toBe(400);

    const empty = await requestJson(`/settings/cabinets/${cab.id}`, token, 'PATCH', { name: '   ' });
    expect(empty.status).toBe(400);

    const same = await requestJson(`/settings/cabinets/${cab.id}`, token, 'PATCH', { name: '102', capacity: 15 });
    expect(same.status).toBe(200);
  });

  it('404 for another school\'s cabinet', async () => {
    const { token } = await setup();
    const otherSchool = await createSchool();
    const foreign = await prisma.cabinet.create({ data: { schoolId: otherSchool.id, name: '101', capacity: 12 } });

    const { status } = await requestJson(`/settings/cabinets/${foreign.id}`, token, 'PATCH', { name: 'hacked' });
    expect(status).toBe(404);
  });
});
