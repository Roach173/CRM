import { Router } from 'express';
import prisma from '../lib/prisma';
import { authenticate, AuthRequest } from '../middleware/authenticate';
import { requirePermission } from '../middleware/requirePermission';
import { Role, MemberStatus } from '@prisma/client';
import bcrypt from 'bcrypt';
import { invalidateUserCache } from '../lib/userCache';
import { applyFreeze, reverseFreeze } from '../services/scheduleLifecycleService';
import type { LifecycleActor } from '../services/scheduleLifecycleTypes';
import { sendLifecycleError } from '../lib/routeError';
import { getPasswordError } from '../lib/passwordPolicy';
import { createLogger } from '../lib/logger';
import { notify } from '../lib/notify';
import { logSecurityEvent } from '../lib/auditLog';

const log = createLogger('users');
const router = Router();

// GET /api/users?role=STUDENT|TEACHER|ADMIN&page=1&limit=50&search=
router.get('/', authenticate, requirePermission('users:read'), async (req: AuthRequest, res) => {
  try {
    const { role, search } = req.query;
    const archived = req.query.archived === 'true';
    const schoolId = req.user!.schoolId;
    const page  = Math.max(1, parseInt(req.query.page  as string) || 1);
    // Archive view can hold a whole school's worth of soft-deleted accounts (e.g. clear-data) → larger cap.
    const limit = Math.min(archived ? 3000 : 200, Math.max(1, parseInt(req.query.limit as string) || 100));
    const skip  = (page - 1) * limit;

    const searchOr = search
      ? [
          { firstName: { contains: search as string, mode: 'insensitive' } },
          { lastName:  { contains: search as string, mode: 'insensitive' } },
          { email:     { contains: search as string, mode: 'insensitive' } },
        ]
      : null;

    const where: Record<string, any> = { schoolId };
    if (role) where.role = role as Role;
    if (archived) {
      // Archive view: surface BOTH manually-archived (archivedAt) and soft-deleted
      // (deletedAt — clear-data / user delete) accounts so none silently disappears.
      const stateOr = [{ archivedAt: { not: null } }, { deletedAt: { not: null } }];
      where.AND = searchOr ? [{ OR: stateOr }, { OR: searchOr }] : [{ OR: stateOr }];
    } else {
      // Active view: hide both soft-deleted and archived accounts.
      where.deletedAt = null;
      where.archivedAt = null;
      if (searchOr) where.OR = searchOr;
    }

    const [total, users] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        skip,
        take: limit,
        select: {
          id: true, firstName: true, lastName: true, email: true, phone: true,
          role: true, schoolId: true, deletedAt: true, archivedAt: true,
          createdAt: true, twoFactorEnabled: true, emailVerified: true,
          studentProfile: {
            include: {
              // GroupMembership is the enrollment source of truth (the legacy
              // StudentGroup.students/enrolledGroups relation is never written by any
              // production route). Mapped to `enrolledGroups` below for the client.
              memberships: {
                where: { status: MemberStatus.ACTIVE, leftAt: null, studentGroup: { deletedAt: null } },
                include: {
                  studentGroup: {
                    include: {
                      blocks: {
                        where: { deletedAt: null },
                        select: { id: true, level: true, days: true, startTime: true, endTime: true, startDate: true, endDate: true },
                      },
                    },
                  },
                },
              },
            },
          },
          staffProfile: {
            include: {
              taughtBlocks: {
                where: { deletedAt: null },
                select: { id: true, level: true, days: true, startTime: true, endTime: true, startDate: true, endDate: true },
              },
            },
          },
        },
        orderBy: archived
          // Newest action first; deletedAt and archivedAt both sort desc with NULLs last.
          ? [{ deletedAt: 'desc' }, { archivedAt: 'desc' }]
          : [{ lastName: 'asc' }, { firstName: 'asc' }],
      }),
    ]);

    const mapped = users.map(u => {
      if (!u.studentProfile) return u;
      const { memberships, ...profileRest } = u.studentProfile as typeof u.studentProfile & {
        memberships: Array<{ studentGroup: unknown }>;
      };
      return { ...u, studentProfile: { ...profileRest, enrolledGroups: memberships.map(m => m.studentGroup) } };
    });

    res.json({ success: true, data: mapped, meta: { total, page, limit, pages: Math.ceil(total / limit) } });
  } catch (error) {
    log.error({ err: error }, 'list users error');
    res.status(500).json({ success: false, error: 'Ошибка сервера' });
  }
});

// Roles that each actor is allowed to create
const ROLE_CREATION_WHITELIST: Partial<Record<Role, Role[]>> = {
  [Role.SUPERADMIN]: [Role.OWNER, Role.ADMIN, Role.TEACHER, Role.STUDENT],
  [Role.OWNER]:      [Role.ADMIN, Role.TEACHER, Role.STUDENT],
  [Role.ADMIN]:      [Role.TEACHER, Role.STUDENT],
};

// Roles the PATCH /:id/role endpoint may assign, keyed by the RESULTING role and
// valued by the roles a target may transition FROM to reach it. SUPERADMIN (and
// TEACHER/STUDENT) are never keys here. The primary guarantee against granting
// SUPERADMIN is the strict-equality check on the untrusted `role` request field
// BEFORE it is used as a lookup key at all (see PATCH /:id/role below) — this
// object is a plain literal, so indexing it with unvalidated input would walk the
// prototype chain (`{"role":"constructor"}` would resolve to `Object`, which is
// truthy). Because the input is validated against the two literal values first,
// that lookup vector is closed off, and this allowlist having no SUPERADMIN key
// is a second, independent backstop.
const ROLE_CHANGE_ALLOWLIST: Partial<Record<Role, Role[]>> = {
  [Role.OWNER]: [Role.ADMIN],   // promote: ADMIN -> OWNER
  [Role.ADMIN]: [Role.OWNER],   // demote:  OWNER -> ADMIN
};

// POST /api/users — создать пользователя
router.post('/', authenticate, requirePermission('users:manage'), async (req: AuthRequest, res) => {
  try {
    const { schoolId, role: actorRole } = req.user!;

    const { firstName, lastName, password, role } = req.body;
    // Login identifiers are all optional individually, but the user needs at
    // least one to be able to log in. email/username stored lowercased; blanks → null.
    const email = req.body.email ? String(req.body.email).toLowerCase().trim() : null;
    const username = req.body.username ? String(req.body.username).toLowerCase().trim() : null;
    const phone = req.body.phone ? String(req.body.phone).trim() : null;

    // Role escalation guard
    const allowedRoles = ROLE_CREATION_WHITELIST[actorRole] ?? [];
    if (!allowedRoles.includes(role as Role)) {
      return res.status(403).json({ success: false, error: 'Недостаточно прав для создания пользователя с такой ролью' });
    }

    if (!password) {
      return res.status(400).json({ success: false, error: 'Пароль обязателен' });
    }
    const passwordError = getPasswordError(password);
    if (passwordError) {
      return res.status(400).json({ success: false, error: passwordError });
    }
    if (!email && !username && !phone) {
      return res.status(400).json({ success: false, error: 'Укажите хотя бы один идентификатор для входа: email, телефон или никнейм' });
    }

    const hashed = await bcrypt.hash(password, 10);

    // Admin-created accounts are trusted (created by staff with users:manage) and
    // no verification email is sent for this path, so they are verified on creation.
    const user = await prisma.user.create({
      data: {
        firstName, lastName, password: hashed, role, schoolId, emailVerified: true,
        ...(email ? { email } : {}),
        ...(username ? { username } : {}),
        ...(phone ? { phone } : {}),
      },
      select: { id: true, firstName: true, lastName: true, email: true, username: true, phone: true, role: true, schoolId: true, createdAt: true, emailVerified: true, twoFactorEnabled: true },
    });

    if (role === Role.STUDENT) {
      await prisma.studentProfile.create({ data: { userId: user.id, credits: 0 } });
    } else if (role === Role.TEACHER || role === Role.ADMIN || role === Role.OWNER) {
      await prisma.staffProfile.create({ data: { userId: user.id } });
    }

    res.json({ success: true, data: user });
  } catch (error: any) {
    if (error?.code === 'P2002') {
      const target = String(error?.meta?.target ?? '');
      const field = target.includes('email') ? 'email'
        : target.includes('phone') ? 'телефон'
        : target.includes('username') ? 'никнейм' : 'идентификатор';
      return res.status(409).json({ success: false, error: `Такой ${field} уже используется в этой школе` });
    }
    log.error({ err: error }, 'create user error');
    res.status(500).json({ success: false, error: 'Ошибка сервера' });
  }
});

// GET /api/users/:id — получить одного пользователя (учителя/сотрудника)
router.get('/:id', authenticate, requirePermission('users:read'), async (req: AuthRequest, res) => {
  try {
    const { schoolId } = req.user!;
    const userId = Number(req.params.id);

    const user = await prisma.user.findFirst({
      where: { id: userId, schoolId, deletedAt: null },
      select: {
        id: true, firstName: true, lastName: true, email: true, phone: true,
        role: true, schoolId: true, deletedAt: true, archivedAt: true,
        createdAt: true, twoFactorEnabled: true, emailVerified: true,
        staffProfile: {
          include: {
            taughtBlocks: {
              where: { deletedAt: null },
              select: { id: true, level: true, days: true, startTime: true, endTime: true, startDate: true, endDate: true },
            },
          },
        },
        studentProfile: true,
      },
    });

    if (!user) return res.status(404).json({ success: false, error: 'Пользователь не найден' });

    res.json({ success: true, data: user });
  } catch (error) {
    log.error({ err: error }, 'get user by id error');
    res.status(500).json({ success: false, error: 'Ошибка сервера' });
  }
});

// PATCH /api/users/me — обновить свой профиль (имя, фамилия, телефон, email)
router.patch('/me', authenticate, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const { firstName, lastName, phone, email } = req.body;

    const updated = await prisma.user.update({
      where: { id: userId },
      data: {
        ...(firstName !== undefined && { firstName }),
        ...(lastName !== undefined && { lastName }),
        ...(phone !== undefined && { phone: phone ? String(phone).trim() : null }),
        ...(email !== undefined && { email: email ? String(email).toLowerCase().trim() : null }),
      },
      select: { id: true, firstName: true, lastName: true, email: true, phone: true, role: true },
    });

    res.json({ success: true, data: updated });
  } catch (error: any) {
    if (error?.code === 'P2002') {
      const target = String(error?.meta?.target ?? '');
      const field = target.includes('email') ? 'email' : target.includes('phone') ? 'телефон' : 'идентификатор';
      return res.status(409).json({ success: false, error: `Такой ${field} уже используется в этой школе` });
    }
    log.error({ err: error }, 'update own profile error');
    res.status(500).json({ success: false, error: 'Ошибка сервера' });
  }
});

// PATCH /api/users/me/password — сменить пароль
router.patch('/me/password', authenticate, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, error: 'Необходимы текущий и новый пароль' });
    }
    const passwordError = getPasswordError(newPassword);
    if (passwordError) {
      return res.status(400).json({ success: false, error: passwordError });
    }

    const user = await prisma.user.findUnique({ where: { id: userId }, omit: { password: false } });
    if (!user) return res.status(404).json({ success: false, error: 'Пользователь не найден' });

    const match = await bcrypt.compare(currentPassword, user.password);
    if (!match) return res.status(400).json({ success: false, error: 'Неверный текущий пароль' });

    const hashed = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
      where: { id: userId },
      data: { password: hashed, tokenVersion: { increment: 1 } },
    });
    await invalidateUserCache(userId);

    res.json({ success: true });
  } catch (error) {
    log.error({ err: error }, 'change password error');
    res.status(500).json({ success: false, error: 'Ошибка сервера' });
  }
});

// PATCH /api/users/:id/profile — обновить личные данные пользователя (firstName, lastName, phone)
router.patch('/:id/profile', authenticate, requirePermission('users:manage'), async (req: AuthRequest, res) => {
  try {
    const { schoolId } = req.user!;
    const { firstName, lastName, phone } = req.body;
    const userId = Number(req.params.id);

    if (!firstName?.trim() || !lastName?.trim()) {
      return res.status(400).json({ success: false, error: 'Имя и фамилия обязательны' });
    }

    const target = await prisma.user.findFirst({ where: { id: userId, schoolId, deletedAt: null } });
    if (!target) return res.status(404).json({ success: false, error: 'Пользователь не найден' });

    const updated = await prisma.user.update({
      where: { id: userId },
      data: {
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        phone: phone?.trim() || null,
      },
      select: { id: true, firstName: true, lastName: true, email: true, phone: true, role: true },
    });

    res.json({ success: true, data: updated });
  } catch (error) {
    log.error({ err: error }, 'update user profile error');
    res.status(500).json({ success: false, error: 'Ошибка сервера' });
  }
});

// PATCH /api/users/:id/role — сменить роль сотрудника: ADMIN -> OWNER (повышение)
// или OWNER -> ADMIN (понижение). Only these two transitions exist; see
// ROLE_CHANGE_ALLOWLIST above. requirePermission('users:manage') already restricts
// the actor to OWNER/SUPERADMIN (ADMIN has no 'users:manage' — see permissions.ts),
// so that middleware IS guard 1; no parallel role check is duplicated here.
router.patch('/:id/role', authenticate, requirePermission('users:manage'), async (req: AuthRequest, res) => {
  try {
    const { schoolId, userId: requesterId } = req.user!;
    const userId = Number(req.params.id);

    // Guard 5 — structurally impossible to grant SUPERADMIN (or TEACHER/STUDENT,
    // or anything else). `req.body.role` is attacker-controlled JSON, so it is
    // checked with strict `===` against the two permitted literal values BEFORE
    // it is used for anything — no `as Role` cast, no object-key lookup on
    // unvalidated input. This also closes a prototype-chain vector that a naive
    // `ROLE_CHANGE_ALLOWLIST[req.body.role as Role]` lookup would have: a payload
    // like `{"role":"constructor"}` would otherwise resolve to `Object` (truthy,
    // inherited via Object.prototype) and slip past a bare `if (!allowedFrom)`
    // check. Missing, non-string, or any other value is rejected right here.
    const roleInput = req.body?.role;
    if (roleInput !== Role.OWNER && roleInput !== Role.ADMIN) {
      return res.status(400).json({ success: false, error: 'Недопустимая целевая роль' });
    }
    const newRole: Role = roleInput;

    // `newRole` is now guaranteed to be exactly Role.OWNER or Role.ADMIN (the only
    // two keys ROLE_CHANGE_ALLOWLIST defines), so this lookup can never actually be
    // undefined at runtime — the check below is unreachable defense-in-depth kept
    // only to satisfy the `Partial<Record<Role, Role[]>>` type, not the real guard.
    const allowedFrom = ROLE_CHANGE_ALLOWLIST[newRole];
    if (!allowedFrom) {
      return res.status(400).json({ success: false, error: 'Недопустимая целевая роль' });
    }

    // Guard 3 — no self-service role change (blocks both self-escalation and self-lockout).
    if (userId === requesterId) {
      return res.status(400).json({ success: false, error: 'Нельзя изменить собственную роль' });
    }

    // Every member carries every property (absent ones typed `?: undefined`)
    // instead of relying on `'x' in result` / `!result.ok` narrowing collapsing
    // the union correctly. That narrowing behavior is NOT config-stable in this
    // codebase: server/tsconfig.test.json sets `strict: false` for ts-jest (see
    // jest.config.js), which disables strictNullChecks, and under that config a
    // slimmer two-shape union stopped narrowing `result.status` as accessible on
    // the `ok: false` branch (TS2339) even though the same code was clean under
    // the strict tsconfig.json used by `tsc --noEmit`. Giving both members every
    // key make the property access valid under either setting.
    type RoleChangeResult =
      | { ok: true; updated: { id: number; firstName: string; lastName: string; email: string | null; phone: string | null; role: Role; schoolId: number | null }; previousRole: Role; status?: undefined; message?: undefined }
      | { ok: false; status: number; message: string; updated?: undefined; previousRole?: undefined };

    const result: RoleChangeResult = await prisma.$transaction(async (tx): Promise<RoleChangeResult> => {
      // Guard 2 — same-school only. `schoolId` comes from the authenticated actor's
      // JWT exactly like every other route in this file (see /:id/profile, /:id/archive
      // above); SUPERADMIN's schoolId is null at auth time (authenticate.ts), so this
      // is not a special SUPERADMIN case, it is the same scoping used everywhere else
      // in users.ts, and it has the side effect of keeping SUPERADMIN out of this
      // school-scoped route — consistent with how the rest of the file treats it.
      //
      // Guard 4 — the target's CURRENT role must be in `allowedFrom` (only
      // OWNER/ADMIN ever appear there), so a SUPERADMIN row can never be the target
      // of this endpoint even if schoolId happened to match.
      const target = await tx.user.findFirst({
        where: { id: userId, schoolId, role: { in: allowedFrom }, deletedAt: null },
        select: { id: true, role: true, firstName: true, lastName: true },
      });
      if (!target) {
        return { ok: false, status: 404, message: 'Пользователь не найден или изменение роли для него недоступно' };
      }

      // Guard 6 — at least one OWNER must remain in the school. Being inside
      // prisma.$transaction is NOT sufficient by itself: Postgres defaults to READ
      // COMMITTED, so a plain `tx.user.count(...)` here would let two concurrent
      // demotions of two DIFFERENT owners in a 2-owner school both read count=2,
      // both pass, and both commit — zero owners left, an unrecoverable lockout
      // (no one left inside the tenant could promote anyone back). Race-safety
      // instead comes from FOR UPDATE, the same row-lock pattern already used
      // throughout this codebase for equivalent races (see
      // attendanceFinalizationService.ts, freezeService.ts, paymentService.ts,
      // creditIssuanceService.ts — all lock the row(s) whose state decides the
      // branch before reading them). Locking every current OWNER row means a
      // second concurrent demotion blocks until the first transaction commits,
      // then re-reads a fresh, accurate set — so the second demotion correctly
      // sees the reduced count and is rejected.
      if (target.role === Role.OWNER && newRole === Role.ADMIN) {
        const lockedOwners = await tx.$queryRaw<{ id: number }[]>`
          SELECT id FROM "User"
          WHERE "schoolId" = ${schoolId} AND role = 'OWNER' AND "deletedAt" IS NULL
          ORDER BY id
          FOR UPDATE
        `;
        if (lockedOwners.length <= 1) {
          return { ok: false, status: 400, message: 'В школе должен остаться хотя бы один владелец' };
        }
      }

      // ADMIN and OWNER both get a StaffProfile at creation time (see POST / above:
      // `role === Role.TEACHER || role === Role.ADMIN || role === Role.OWNER` all hit
      // the same `staffProfile.create` branch) — so no related record needs to be
      // created, migrated or deleted here; only the role column itself changes.
      const updated = await tx.user.update({
        where: { id: userId },
        data: { role: newRole },
        select: { id: true, firstName: true, lastName: true, email: true, phone: true, role: true, schoolId: true },
      });

      return { ok: true, updated, previousRole: target.role };
    }); // Guard 7 — the whole read-check-write sequence runs inside one Prisma transaction.

    if (!result.ok) {
      return res.status(result.status).json({ success: false, error: result.message });
    }

    await invalidateUserCache(userId);

    const isPromotion = newRole === Role.OWNER;
    try {
      await notify({
        userId: result.updated.id,
        schoolId: schoolId!,
        type: 'STAFF_ROLE_CHANGED',
        category: 'STAFF',
        priority: 'HIGH',
        title: isPromotion ? 'Повышение до владельца' : 'Роль изменена',
        body: isPromotion
          ? 'Ваша роль изменена на «Владелец». Теперь у вас есть доступ к выплате зарплаты, финансам, настройкам школы и удалению данных школы.'
          : 'Ваша роль изменена на «Администратор». Доступ к выплате зарплаты, финансам, настройкам школы и удалению данных школы больше недоступен.',
        entityType: 'User',
        entityId: result.updated.id,
        data: { previousRole: result.previousRole, newRole, changedById: requesterId },
      });
    } catch (notifyError) {
      // Non-fatal — the role change already committed; a notification failure must not roll it back.
      log.error({ err: notifyError }, 'role change notification failed');
    }

    await logSecurityEvent({
      event: 'ROLE_CHANGED',
      schoolId,
      userId: requesterId,
      details: { targetUserId: result.updated.id, previousRole: result.previousRole, newRole },
      req,
    });

    res.json({ success: true, data: result.updated });
  } catch (error) {
    log.error({ err: error }, 'change user role error');
    res.status(500).json({ success: false, error: 'Ошибка сервера' });
  }
});

// PATCH /api/users/:id/freeze — заморозить/разморозить студента
// PR 6: routed through lifecycle service — audit, notification, lifecycle event.
router.patch('/:id/freeze', authenticate, requirePermission('students:write'), async (req: AuthRequest, res) => {
  try {
    const { schoolId } = req.user!;
    const { isFrozen, reason } = req.body;
    const userId = Number(req.params.id);

    const target = await prisma.user.findFirst({
      where: { id: userId, schoolId, deletedAt: null },
      include: { studentProfile: { select: { id: true } } },
    });
    if (!target) return res.status(404).json({ success: false, error: 'Пользователь не найден' });
    if (!target.studentProfile) {
      return res.status(404).json({ success: false, error: 'Профиль студента не найден' });
    }

    const actor: LifecycleActor = {
      userId:   req.user!.userId,
      role:     req.user!.role,
      schoolId: schoolId!,
    };

    const profile = Boolean(isFrozen)
      ? await applyFreeze({ studentProfileId: target.studentProfile.id, schoolId: schoolId!, actor, reason })
      : await reverseFreeze({ studentProfileId: target.studentProfile.id, schoolId: schoolId!, actor, reason });

    res.json({ success: true, data: profile });
  } catch (error: any) {
    sendLifecycleError(res, error, 'Ошибка сервера');
  }
});

// PATCH /api/users/:id/level — изменить уровень и/или главу студента
router.patch('/:id/level', authenticate, requirePermission('students:write'), async (req: AuthRequest, res) => {
  try {
    const { schoolId } = req.user!;

    const { level, chapter } = req.body;
    const userId = Number(req.params.id);

    const target = await prisma.user.findFirst({ where: { id: userId, schoolId, deletedAt: null } });
    if (!target) return res.status(404).json({ success: false, error: 'Пользователь не найден' });

    const profile = await prisma.studentProfile.update({
      where: { userId },
      data: {
        ...(level !== undefined && { level }),
        ...(chapter !== undefined && { chapter: Number(chapter) }),
      },
    });

    res.json({ success: true, data: profile });
  } catch (error) {
    log.error({ err: error }, 'update student level error');
    res.status(500).json({ success: false, error: 'Ошибка сервера' });
  }
});

// PATCH /api/users/:id/archive — переместить сотрудника (учитель/админ) в архив (soft, reversible)
router.patch('/:id/archive', authenticate, requirePermission('users:manage'), async (req: AuthRequest, res) => {
  try {
    const { schoolId, userId: requesterId } = req.user!;
    const userId = Number(req.params.id);

    if (userId === requesterId) {
      return res.status(400).json({ success: false, error: 'Нельзя архивировать собственный аккаунт' });
    }

    const target = await prisma.user.findFirst({
      where: { id: userId, schoolId, role: { in: [Role.TEACHER, Role.ADMIN] }, deletedAt: null, archivedAt: null },
      select: { id: true },
    });
    if (!target) return res.status(404).json({ success: false, error: 'Сотрудник не найден или уже в архиве' });

    await prisma.user.update({ where: { id: userId }, data: { archivedAt: new Date() } });

    res.json({ success: true });
  } catch (error) {
    log.error({ err: error }, 'archive user error');
    res.status(500).json({ success: false, error: 'Ошибка сервера' });
  }
});

// PATCH /api/users/:id/unarchive — восстановить сотрудника из архива ИЛИ из soft-delete.
// Снимает archivedAt + deletedAt (User) и staffProfile.deletedAt, чтобы аккаунт вернулся в активный список.
router.patch('/:id/unarchive', authenticate, requirePermission('users:manage'), async (req: AuthRequest, res) => {
  try {
    const { schoolId } = req.user!;
    const userId = Number(req.params.id);

    const target = await prisma.user.findFirst({
      where: {
        id: userId, schoolId, role: { in: [Role.TEACHER, Role.ADMIN] },
        OR: [{ archivedAt: { not: null } }, { deletedAt: { not: null } }],
      },
      select: { id: true, staffProfile: { select: { id: true } } },
    });
    if (!target) return res.status(404).json({ success: false, error: 'Сотрудник не найден или не в архиве' });

    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { archivedAt: null, deletedAt: null } });
      if (target.staffProfile) {
        await tx.staffProfile.update({ where: { id: target.staffProfile.id }, data: { deletedAt: null } });
      }
    });
    await invalidateUserCache(userId);

    res.json({ success: true });
  } catch (error) {
    log.error({ err: error }, 'unarchive user error');
    res.status(500).json({ success: false, error: 'Ошибка сервера' });
  }
});

// DELETE /api/users/:id — мягкое удаление пользователя (deletedAt)
router.delete('/:id', authenticate, requirePermission('users:manage'), async (req: AuthRequest, res) => {
  try {
    const { schoolId, userId: requesterId } = req.user!;
    const userId = Number(req.params.id);

    if (userId === requesterId) {
      return res.status(400).json({ success: false, error: 'Нельзя удалить собственный аккаунт' });
    }

    const target = await prisma.user.findFirst({ where: { id: userId, schoolId, deletedAt: null } });
    if (!target) return res.status(404).json({ success: false, error: 'Пользователь не найден' });

    await prisma.user.update({
      where: { id: userId },
      data: { deletedAt: new Date(), tokenVersion: { increment: 1 } },
    });
    await invalidateUserCache(userId);

    res.json({ success: true });
  } catch (error) {
    log.error({ err: error }, 'delete user error');
    res.status(500).json({ success: false, error: 'Ошибка сервера' });
  }
});

// PATCH /api/users/:id/staff-profile — обновить рабочие дни, лимит уроков, ставку и заметку сотрудника
router.patch('/:id/staff-profile', authenticate, requirePermission('schedule:write'), async (req: AuthRequest, res) => {
  try {
    const { schoolId } = req.user!;

    const { workingDays, maxLessonsPerDay, salaryRate, notes } = req.body;
    const userId = Number(req.params.id);

    // salaryRate is a financial field — same OWNER-only gate salary.ts enforces for
    // PATCH /rate/:staffProfileId. ADMIN may still edit workingDays/maxLessonsPerDay/notes.
    if (salaryRate !== undefined && req.user!.role !== 'OWNER' && req.user!.role !== 'SUPERADMIN') {
      return res.status(403).json({ success: false, error: 'Изменение ставки доступно только владельцу' });
    }

    const target = await prisma.user.findFirst({ where: { id: userId, schoolId, deletedAt: null } });
    if (!target) return res.status(404).json({ success: false, error: 'Пользователь не найден' });

    const updateData: any = {};
    if (notes !== undefined) updateData.notes = notes === null ? null : String(notes);
    if (Array.isArray(workingDays)) updateData.workingDays = workingDays.map(Number);
    if (maxLessonsPerDay !== undefined) updateData.maxLessonsPerDay = maxLessonsPerDay === null ? null : Number(maxLessonsPerDay);
    const newRate = salaryRate !== undefined
      ? ((salaryRate === null || salaryRate === '') ? null : Number(salaryRate))
      : undefined;
    if (newRate !== undefined) updateData.salaryRate = newRate;

    const profile = await prisma.staffProfile.upsert({
      where: { userId },
      create: { userId, ...updateData },
      update: updateData,
    });

    // Write rate history when salaryRate changes (append-only, never overwrite)
    if (newRate !== null && newRate !== undefined && newRate > 0) {
      await prisma.teacherRateLog.create({
        data: {
          staffProfileId: profile.id,
          rate: newRate,
          effectiveFrom: new Date(),
          changedById: req.user!.userId,
        },
      });
    }

    res.json({ success: true, data: profile });
  } catch (error: any) {
    log.error({ err: error }, 'update staff profile error');
    res.status(500).json({ success: false, error: error?.message ?? 'Ошибка при сохранении настроек' });
  }
});

export default router;