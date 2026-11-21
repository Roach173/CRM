import { Router, Response } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import prisma from '../lib/prisma';
import { authenticate, AuthRequest } from '../middleware/authenticate';
import { requirePermission } from '../middleware/requirePermission';
import { subscriptionGuard } from '../middleware/subscriptionGuard';
import { Role } from '@prisma/client';
import { sendStaffInviteEmail } from '../lib/email';
import { createLogger } from '../lib/logger';
import * as notificationService from '../services/notificationService';
import { getPasswordError } from '../lib/passwordPolicy';
import { ACCESS_TOKEN_TTL } from '../lib/jwtSecret';

const log = createLogger('invites');
const router = Router();

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('JWT_SECRET is not set in environment variables');

const REFRESH_COOKIE = 'rt';
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

async function issueRefreshCookie(userId: number, res: Response): Promise<void> {
  const token = crypto.randomBytes(64).toString('hex');
  const expiresAt = new Date(Date.now() + REFRESH_TTL_MS);

  // Multi-device login: see auth.ts issueRefreshCookie for why other active
  // sessions are no longer revoked here.
  await prisma.refreshToken.create({ data: { token, userId, expiresAt } });

  // Must match auth.ts's REFRESH_COOKIE_OPTS: in production the client and API are
  // separate cross-origin Railway services, so SameSite=Lax gets silently dropped by
  // the browser and the just-invited user's session wouldn't persist past this request.
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    maxAge: REFRESH_TTL_MS,
    path: '/',
  });
}

// 1. POST /api/v1/invites (Send Invite)
router.post('/', authenticate, subscriptionGuard, requirePermission('users:manage'), async (req: AuthRequest, res) => {
  try {
    const { schoolId } = req.user!;
    let { email, role, firstName, lastName, phone } = req.body;

    if (!email || !role) {
      return res.status(400).json({ success: false, error: 'Email и роль обязательны.' });
    }

    email = email.toLowerCase().trim();

    // Whitelist roles: only ADMIN or TEACHER can be invited
    if (role !== Role.ADMIN && role !== Role.TEACHER) {
      return res.status(400).json({ success: false, error: 'Неверная роль. Разрешено приглашать только администраторов и учителей.' });
    }

    // Check school existence
    const school = await prisma.school.findFirst({ where: { id: schoolId, deletedAt: null } });
    if (!school) {
      return res.status(404).json({ success: false, error: 'Школа не найдена.' });
    }

    // Check existing User by email
    const existingUser = await prisma.user.findFirst({ where: { email, deletedAt: null } });
    if (existingUser) {
      if (existingUser.schoolId === schoolId) {
        return res.status(400).json({ success: false, error: 'Пользователь с таким email уже зарегистрирован в вашей школе.' });
      } else {
        return res.status(400).json({ success: false, error: 'Пользователь с таким email уже зарегистрирован в другой организации.' });
      }
    }

    // Check duplicate active pending invites in this school
    const pendingInvite = await prisma.staffInvite.findFirst({
      where: {
        schoolId,
        email,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() }
      }
    });

    if (pendingInvite) {
      return res.status(409).json({ success: false, error: 'Приглашение для этого email уже отправлено.' });
    }

    const plainToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(plainToken).digest('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    const invite = await prisma.staffInvite.create({
      data: {
        schoolId,
        email,
        role,
        firstName: firstName || null,
        lastName: lastName || null,
        phone: phone || null,
        tokenHash,
        expiresAt
      }
    });

    const inviteLink = `${process.env.CLIENT_URL || 'http://localhost:5173'}/invite?token=${plainToken}`;
    const emailResult = await sendStaffInviteEmail(email, inviteLink, school.name, role, 7);

    res.json({
      success: true,
      data: {
        invite: {
          id: invite.id,
          email: invite.email,
          role: invite.role,
          firstName: invite.firstName,
          lastName: invite.lastName,
          phone: invite.phone,
          expiresAt: invite.expiresAt,
          createdAt: invite.createdAt
        },
        devInviteLink: process.env.NODE_ENV === 'development' ? (emailResult.data as any)?.inviteLink : undefined
      }
    });

  } catch (error) {
    log.error({ err: error }, 'Create invite error');
    res.status(500).json({ success: false, error: 'Внутренняя ошибка сервера при создании приглашения.' });
  }
});

// 2. GET /api/v1/invites/validate?token=... (Validate Invite)
router.get('/validate', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ success: false, error: 'Токен обязателен.' });
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const invite = await prisma.staffInvite.findUnique({
      where: { tokenHash },
      include: { school: true }
    });

    if (!invite || invite.school.deletedAt) {
      return res.status(404).json({ success: false, error: 'Приглашение не найдено.' });
    }

    if (invite.acceptedAt) {
      return res.status(400).json({ success: false, error: 'Приглашение уже принято.' });
    }

    if (invite.revokedAt) {
      return res.status(400).json({ success: false, error: 'Приглашение отозвано.' });
    }

    if (invite.expiresAt < new Date()) {
      return res.status(400).json({ success: false, error: 'Срок действия приглашения истек.' });
    }

    res.json({
      success: true,
      data: {
        invite: {
          email: invite.email,
          role: invite.role,
          firstName: invite.firstName,
          lastName: invite.lastName,
          phone: invite.phone,
          expiresAt: invite.expiresAt
        },
        school: {
          name: invite.school.name,
          slug: invite.school.slug
        }
      }
    });

  } catch (error) {
    log.error({ err: error }, 'Validate invite error');
    res.status(500).json({ success: false, error: 'Внутренняя ошибка сервера при проверке токена.' });
  }
});

// 3. POST /api/v1/invites/accept (Accept Invite / Claim Account)
router.post('/accept', async (req, res) => {
  try {
    const { token, firstName, lastName, password, phone } = req.body;

    if (!token || !firstName || !lastName || !password) {
      return res.status(400).json({ success: false, error: 'Необходимые поля отсутствуют.' });
    }

    const passwordError = getPasswordError(password);
    if (passwordError) {
      return res.status(400).json({ success: false, error: passwordError });
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const invite = await prisma.staffInvite.findUnique({
      where: { tokenHash },
      include: { school: true }
    });

    if (!invite || invite.school.deletedAt) {
      return res.status(404).json({ success: false, error: 'Приглашение не найдено.' });
    }

    if (invite.acceptedAt) {
      return res.status(400).json({ success: false, error: 'Приглашение уже принято.' });
    }

    if (invite.revokedAt) {
      return res.status(400).json({ success: false, error: 'Приглашение отозвано.' });
    }

    if (invite.expiresAt < new Date()) {
      return res.status(400).json({ success: false, error: 'Срок действия приглашения истек.' });
    }

    // Double check email uniqueness to prevent race conditions
    const existingUser = await prisma.user.findFirst({ where: { email: invite.email, deletedAt: null } });
    if (existingUser) {
      return res.status(400).json({ success: false, error: 'Пользователь с таким email уже зарегистрирован.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const user = await prisma.$transaction(async (tx) => {
      // 1. Create User
      const createdUser = await tx.user.create({
        data: {
          email: invite.email,
          password: passwordHash,
          firstName,
          lastName,
          role: invite.role,
          schoolId: invite.schoolId,
          phone: phone || invite.phone || undefined,
          emailVerified: true // auto-verified via secure invite claiming
        }
      });

      // 2. Create StaffProfile
      await tx.staffProfile.create({
        data: {
          userId: createdUser.id
        }
      });

      // 3. Mark Invite as Accepted
      await tx.staffInvite.update({
        where: { id: invite.id },
        data: { acceptedAt: new Date() }
      });

      return createdUser;
    });

    try {
      const school = await prisma.school.findUnique({
        where: { id: invite.schoolId },
        select: { slug: true }
      });
      const schoolSlug = school?.slug || '';
      const staffName = `${firstName} ${lastName}`.trim();

      await notificationService.createForRole({
        schoolId: invite.schoolId,
        role: Role.OWNER,
        type: 'STAFF_INVITE_ACCEPTED',
        title: 'Приглашение принято',
        body: `${staffName} (${invite.role}) присоединился к школе.`,
        category: 'STAFF',
        priority: 'NORMAL',
        actionUrl: `/${schoolSlug}/owner/staff`,
        entityType: 'User',
        entityId: user.id,
        data: {
          inviteId: invite.id,
          role: invite.role,
          email: invite.email,
        }
      });

      await notificationService.createForRole({
        schoolId: invite.schoolId,
        role: Role.ADMIN,
        type: 'STAFF_INVITE_ACCEPTED',
        title: 'Приглашение принято',
        body: `${staffName} (${invite.role}) присоединился к школе.`,
        category: 'STAFF',
        priority: 'NORMAL',
        actionUrl: `/${schoolSlug}/admin/teachers`,
        entityType: 'User',
        entityId: user.id,
        data: {
          inviteId: invite.id,
          role: invite.role,
          email: invite.email,
        }
      });
    } catch (err) {
      log.error({ err }, 'Failed to create notifications for staff invite accept');
    }

    const jwtToken = jwt.sign(
      { userId: user.id, schoolId: user.schoolId ?? null, role: user.role, tokenVersion: user.tokenVersion },
      JWT_SECRET,
      { expiresIn: ACCESS_TOKEN_TTL }
    );

    await issueRefreshCookie(user.id, res);

    res.json({
      success: true,
      data: {
        token: jwtToken,
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          role: user.role,
          schoolId: user.schoolId ?? null
        },
        school: {
          id: invite.school.id,
          name: invite.school.name,
          slug: invite.school.slug,
          city: invite.school.city
        }
      }
    });

  } catch (error) {
    log.error({ err: error }, 'Accept invite error');
    res.status(500).json({ success: false, error: 'Внутренняя ошибка сервера при принятии приглашения.' });
  }
});

// 4. GET /api/v1/invites (List School Invites)
router.get('/', authenticate, subscriptionGuard, requirePermission('users:manage'), async (req: AuthRequest, res) => {
  try {
    const { schoolId } = req.user!;

    const invites = await prisma.staffInvite.findMany({
      where: { schoolId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        email: true,
        role: true,
        firstName: true,
        lastName: true,
        phone: true,
        expiresAt: true,
        acceptedAt: true,
        revokedAt: true,
        createdAt: true
      }
    });

    res.json({ success: true, data: invites });

  } catch (error) {
    log.error({ err: error }, 'List invites error');
    res.status(500).json({ success: false, error: 'Внутренняя ошибка сервера при получении списка приглашений.' });
  }
});

// 5. DELETE /api/v1/invites/:id (Revoke Invite)
router.delete('/:id', authenticate, subscriptionGuard, requirePermission('users:manage'), async (req: AuthRequest, res) => {
  try {
    const { schoolId } = req.user!;
    const inviteId = parseInt(req.params.id);

    if (isNaN(inviteId)) {
      return res.status(400).json({ success: false, error: 'Неверный ID приглашения.' });
    }

    const invite = await prisma.staffInvite.findFirst({
      where: { id: inviteId, schoolId }
    });

    if (!invite) {
      return res.status(404).json({ success: false, error: 'Приглашение не найдено.' });
    }

    if (invite.acceptedAt) {
      return res.status(400).json({ success: false, error: 'Нельзя отозвать уже принятое приглашение.' });
    }

    await prisma.staffInvite.update({
      where: { id: inviteId },
      data: { revokedAt: new Date() }
    });

    res.json({ success: true });

  } catch (error) {
    log.error({ err: error }, 'Revoke invite error');
    res.status(500).json({ success: false, error: 'Внутренняя ошибка сервера при отзыве приглашения.' });
  }
});

export default router;
