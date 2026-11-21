import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcrypt';
import prisma from '../lib/prisma';
import { authenticate, AuthRequest } from '../middleware/authenticate';
import { requirePermission } from '../middleware/requirePermission';
import { validateBody } from '../middleware/validate';
import { Role, PaymentMethod, MemberStatus, Prisma } from '@prisma/client';
import { createLogger } from '../lib/logger';
import * as notificationService from '../services/notificationService';
import { applyFreeze, reverseFreeze } from '../services/scheduleLifecycleService';
import type { LifecycleActor } from '../services/scheduleLifecycleTypes';
import { recomputeAndPersistPaidUntil } from '../lib/paidUntilDerivation';
import { MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH, isCommonPassword } from '../lib/passwordPolicy';
import { sendLifecycleError } from '../lib/routeError';

const log = createLogger('students');
const router = Router();

// Previously firstName/lastName/password went straight into bcrypt.hash() with
// no validation — an empty-string password silently hashed to a valid (empty)
// password, same bug class as the bulk-import defaultPassword issue.
const createStudentSchema = z.object({
  firstName: z.string().trim().min(1, 'firstName обязателен'),
  lastName: z.string().trim().min(1, 'lastName обязателен'),
  password: z.string()
    .min(MIN_PASSWORD_LENGTH, `Пароль должен содержать минимум ${MIN_PASSWORD_LENGTH} символов.`)
    .max(MAX_PASSWORD_LENGTH, `Пароль слишком длинный (максимум ${MAX_PASSWORD_LENGTH} символов).`)
    .refine(p => !isCommonPassword(p), 'Этот пароль слишком распространён, выберите другой.'),
  email: z.string().trim().min(1).optional(),
  phone: z.string().trim().min(1).optional(),
  username: z.string().trim().min(1).optional(),
  level: z.string().optional(),
  chapter: z.union([z.number(), z.string()]).optional(),
}).refine(d => d.email || d.phone || d.username, { message: 'Укажите email, телефон или логин' });

// GroupMembership is the enrollment source of truth (the legacy StudentGroup.students/
// enrolledGroups relation is never written by any production route — see
// scheduleValidation.ts). Every endpoint that returns a studentProfile must remap
// `memberships` to `enrolledGroups` through here, not roll its own copy.
function mapEnrolledGroups(profile: any) {
  if (!profile) return null;
  const { memberships, ...rest } = profile;
  return { ...rest, enrolledGroups: (memberships ?? []).map((m: any) => m.studentGroup) };
}

// Get all students (paginated, server-side filtering) or archived students (?archived=true)
// Gated to staff (students:read = TEACHER/ADMIN/OWNER/SUPERADMIN). Without this a STUDENT
// could enumerate the whole school roster with classmates' email/phone/credits/paidUntil.
router.get('/', authenticate, requirePermission('students:read'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user?.schoolId;
    const { search, filter, level, cabinet } = req.query;
    const archived = req.query.archived === 'true';
    const page  = Math.max(1, parseInt(req.query.page  as string) || 1);
    const limit = Math.min(3000, Math.max(1, parseInt(req.query.limit as string) || 50));
    const skip  = (page - 1) * limit;

    const studentSelect = {
      id: true, firstName: true, lastName: true, email: true, phone: true, username: true, archivedAt: true, deletedAt: true,
      studentProfile: {
        select: {
          id: true, level: true, chapter: true, credits: true,
          isFrozen: true, isVerified: true, paidUntil: true,
          memberships: {
            where: { status: MemberStatus.ACTIVE, leftAt: null, studentGroup: { deletedAt: null } },
            take: 1,
            select: {
              studentGroup: {
                select: {
                  id: true, level: true,
                  blocks: {
                    where: { deletedAt: null },
                    take: 1,
                    select: { id: true, startTime: true, endTime: true, days: true, cabinet: { select: { id: true, name: true } } },
                  },
                },
              },
            },
          },
        },
      },
    };

    // ── Archived view ─────────────────────────────────────────────────────────
    // Shows BOTH archived (archivedAt) and soft-deleted (deletedAt) students so no
    // account ever silently disappears (e.g. clear-data or user delete set deletedAt).
    if (archived) {
      const stateOr = [
        { archivedAt: { not: null } },
        { deletedAt: { not: null } },
      ];
      const archivedBase: Record<string, any> = {
        schoolId, role: Role.STUDENT,
        ...(search
          ? {
              AND: [
                { OR: stateOr },
                { OR: [
                    { firstName: { contains: search as string, mode: 'insensitive' } },
                    { lastName:  { contains: search as string, mode: 'insensitive' } },
                    { email:     { contains: search as string, mode: 'insensitive' } },
                  ] },
              ],
            }
          : { OR: stateOr }),
      };
      const [total, students] = await Promise.all([
        prisma.user.count({ where: archivedBase }),
        // Newest action first; deletedAt and archivedAt both sort desc with NULLs last.
        prisma.user.findMany({ where: archivedBase, skip, take: limit, orderBy: [{ deletedAt: 'desc' }, { archivedAt: 'desc' }], select: studentSelect }),
      ]);
      return res.json({
        success: true,
        data: students.map(s => ({ ...s, studentProfile: mapEnrolledGroups(s.studentProfile) })),
        meta: { total, page, limit, pages: Math.ceil(total / limit) },
      });
    }

    // ── Active view ───────────────────────────────────────────────────────────

    // Base profile filter (search-independent status conditions)
    const profileBase: Record<string, any> = { deletedAt: null };
    if (level)   profileBase.OR = [
      { level: level as string },
      { memberships: { some: { status: MemberStatus.ACTIVE, leftAt: null, studentGroup: { deletedAt: null, level: level as string } } } },
    ];
    if (cabinet) profileBase.memberships = {
      some: { status: MemberStatus.ACTIVE, leftAt: null, studentGroup: { deletedAt: null, blocks: { some: { deletedAt: null, cabinet: { name: cabinet as string } } } } },
    };

    // Base WHERE: active = not deleted, not archived
    const userBase: Record<string, any> = { schoolId, role: Role.STUDENT, deletedAt: null, archivedAt: null };
    if (search) userBase.OR = [
      { firstName: { contains: search as string, mode: 'insensitive' } },
      { lastName:  { contains: search as string, mode: 'insensitive' } },
      { email:     { contains: search as string, mode: 'insensitive' } },
    ];

    function withStatus(status: string): Record<string, any> {
      const p = { ...profileBase };
      // ponytail: StudentFreeze is SOT for freeze — isFrozen is denormalized cache only
      if (status === 'paused') {
        p.freezes = { some: { status: 'ACTIVE' } };
      }
      if (status === 'active') {
        p.NOT = { freezes: { some: { status: 'ACTIVE' } } };
        p.credits = { gt: 0 };
      }
      if (status === 'overdue') {
        p.NOT = { freezes: { some: { status: 'ACTIVE' } } };
        p.credits = { lte: 0 };
      }
      return { ...userBase, studentProfile: p };
    }

    const filterWhere = filter && filter !== 'all' ? withStatus(filter as string) : { ...userBase, studentProfile: profileBase };

    const [total, students, cntActive, cntOverdue, cntPaused] = await Promise.all([
      prisma.user.count({ where: filterWhere }),
      prisma.user.findMany({ where: filterWhere, skip, take: limit, orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }], select: studentSelect }),
      prisma.user.count({ where: withStatus('active') }),
      prisma.user.count({ where: withStatus('overdue') }),
      prisma.user.count({ where: withStatus('paused') }),
    ]);

    const cntAll = cntActive + cntOverdue + cntPaused;

    res.json({
      success: true,
      data: students.map(s => ({ ...s, studentProfile: mapEnrolledGroups(s.studentProfile) })),
      meta: { total, page, limit, pages: Math.ceil(total / limit), counts: { all: cntAll, active: cntActive, overdue: cntOverdue, paused: cntPaused } },
    });
  } catch (error) {
    log.error({ err: error }, 'students route error');
    res.status(500).json({ success: false, error: 'Failed to fetch students' });
  }
});

// Register new student
router.post('/', authenticate, requirePermission('students:write'), validateBody(createStudentSchema), async (req: AuthRequest, res) => {
  try {

    const { firstName, lastName, password, level, chapter } = req.body;
    const schoolId = req.user!.schoolId;
    const email = req.body.email ? String(req.body.email).toLowerCase().trim() : null;
    const phone = req.body.phone ? String(req.body.phone).trim() : null;
    let username = req.body.username ? String(req.body.username).toLowerCase().trim() : null;

    if (email) {
      const existingUser = await prisma.user.findFirst({ where: { schoolId, email, deletedAt: null } });
      if (existingUser) {
        return res.status(400).json({ success: false, error: 'Email already exists' });
      }
    }

    // Registration is phone-first: every phone-based student always gets a
    // personal login "<phone>-01", "<phone>-02", ... — not only once a sibling
    // collides. That's what makes the raw phone number safe to share within a
    // family (see auth.ts login) without any account ever being login-locked.
    if (!username && phone) {
      let n = 1;
      while (await prisma.user.findFirst({ where: { schoolId, username: `${phone}-${String(n).padStart(2, '0')}`, deletedAt: null } })) {
        n++;
      }
      username = `${phone}-${String(n).padStart(2, '0')}`;
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const student = await prisma.user.create({
      data: {
        firstName,
        lastName,
        password: hashedPassword,
        role: Role.STUDENT,
        schoolId,
        emailVerified: true, // admin-created account is trusted, nothing to verify
        ...(email ? { email } : {}),
        ...(phone ? { phone } : {}),
        ...(username ? { username } : {}),
        studentProfile: {
          create: {
            level,
            chapter: chapter ? parseInt(chapter) : 1,
            credits: 0,
          }
        }
      },
      select: {
        id: true, firstName: true, lastName: true, email: true, phone: true, username: true,
        role: true, schoolId: true, createdAt: true, emailVerified: true, twoFactorEnabled: true,
        studentProfile: true,
      },
    });

    try {
      const school = await prisma.school.findUnique({
        where: { id: schoolId },
        select: { slug: true }
      });
      const schoolSlug = school?.slug || '';
      const studentName = `${firstName} ${lastName}`.trim();

      await notificationService.createForRole({
        schoolId,
        role: Role.OWNER,
        type: 'STUDENT_CREATED',
        title: 'Новый ученик добавлен',
        body: `${studentName} добавлен в школу.`,
        category: 'STUDENTS',
        priority: 'NORMAL',
        actionUrl: `/${schoolSlug}/owner/students`,
        entityType: 'User',
        entityId: student.id,
        data: { studentName }
      });

      await notificationService.createForRole({
        schoolId,
        role: Role.ADMIN,
        type: 'STUDENT_CREATED',
        title: 'Новый ученик добавлен',
        body: `${studentName} добавлен в школу.`,
        category: 'STUDENTS',
        priority: 'NORMAL',
        actionUrl: `/${schoolSlug}/admin/students`,
        entityType: 'User',
        entityId: student.id,
        data: { studentName }
      });
    } catch (err) {
      log.error({ err }, 'Failed to create student created notifications');
    }

    res.json({ success: true, data: student });
  } catch (error) {
    log.error({ err: error }, 'students route error');
    res.status(500).json({ success: false, error: 'Failed to create student' });
  }
});

// Get current student profile
router.get('/me/profile', authenticate, async (req: AuthRequest, res) => {
  try {
    const userId = req.user?.userId;
    const profile = await prisma.studentProfile.findFirst({
      where: { userId, deletedAt: null },
      include: { user: { select: { firstName: true, lastName: true, email: true } } }
    });
    
    if (!profile) return res.status(404).json({ success: false, error: 'Profile not found' });
    res.json({ success: true, data: profile });
  } catch (error) {
    log.error({ err: error }, 'students route error');
    res.status(500).json({ success: false, error: 'Failed to fetch profile' });
  }
});

// Get current student attendance history
router.get('/me/attendance', authenticate, async (req: AuthRequest, res) => {
  try {
    const userId = req.user?.userId;
    const student = await prisma.studentProfile.findFirst({ where: { userId, deletedAt: null } });
    if (!student) return res.status(404).json({ success: false, error: 'Student not found' });

    const page  = Math.max(1, parseInt(req.query.page  as string) || 1);
    const limit = Math.min(100, parseInt(req.query.limit as string) || 50);
    const [total, attendance] = await Promise.all([
      prisma.attendance.count({ where: { studentProfileId: student.id } }),
      prisma.attendance.findMany({
        where: { studentProfileId: student.id },
        include: { lessonSession: { include: { lessonBlock: { select: { type: true } } } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);
    res.json({ success: true, data: attendance, meta: { total, page, limit, pages: Math.ceil(total / limit) } });
  } catch (error) {
    log.error({ err: error }, 'students route error');
    res.status(500).json({ success: false, error: 'Failed to fetch attendance' });
  }
});

// Get current student credit logs (top-ups, adjustments)
router.get('/me/credit-logs', authenticate, async (req: AuthRequest, res) => {
  try {
    const userId = req.user?.userId;
    const student = await prisma.studentProfile.findFirst({ where: { userId, deletedAt: null } });
    if (!student) return res.status(404).json({ success: false, error: 'Student not found' });

    const page  = Math.max(1, parseInt(req.query.page  as string) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit as string) || 100));
    const [total, logs] = await Promise.all([
      prisma.lessonCreditLog.count({ where: { studentProfileId: student.id } }),
      prisma.lessonCreditLog.findMany({
        where: { studentProfileId: student.id },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);
    res.json({ success: true, data: logs, meta: { total, page, limit, pages: Math.ceil(total / limit) } });
  } catch (error) {
    log.error({ err: error }, 'students route error');
    res.status(500).json({ success: false, error: 'Failed to fetch credit logs' });
  }
});

// GET /api/students/:id/payment-history - Get payment records for a student
router.get('/:id/payment-history', authenticate, requirePermission('finance:read'), async (req: AuthRequest, res) => {
  try {
    const userId = parseInt(req.params.id);
    const schoolId = req.user!.schoolId;

    const student = await prisma.user.findFirst({
      where: { id: userId, schoolId, role: Role.STUDENT, deletedAt: null },
      include: { studentProfile: true },
    });

    if (!student?.studentProfile || student.studentProfile.deletedAt) {
      return res.status(404).json({ success: false, error: 'Student not found' });
    }

    // ponytail: month boundary in UTC, not school tz — a few hours' skew at the
    // boundary doesn't matter for a progress %. Switch to school tz if it ever does.
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    const [payments, config, paidAgg] = await Promise.all([
      prisma.studentPayment.findMany({
        where: { studentProfileId: student.studentProfile.id, schoolId },
        orderBy: { createdAt: 'desc' },
        take: 30,
        select: {
          id: true, amount: true, creditsAdded: true,
          pricePerCredit: true, method: true, note: true, createdAt: true, cancelledAt: true,
        },
      }),
      prisma.schoolFinanceConfig.findUnique({ where: { schoolId }, select: { basePrice: true, billingDays: true } }),
      prisma.studentPayment.aggregate({
        // cancelled payments don't count toward the month's paid total
        where: { studentProfileId: student.studentProfile.id, schoolId, createdAt: { gte: monthStart }, cancelledAt: null },
        _sum: { amount: true },
      }),
    ]);

    const monthlyFee = student.studentProfile.monthlyFee;
    const basePrice = config?.basePrice ?? null;

    // Effective per-lesson price and the som banked toward the NEXT lesson.
    // moneyBalance is the running total paid since the last price change; the leftover
    // is what's left after the lessons already granted, valued at the current price.
    const billingDays = config?.billingDays && config.billingDays > 0 ? config.billingDays : 26;
    const feeDec = monthlyFee != null && Number(monthlyFee) > 0
      ? monthlyFee
      : (config?.basePrice ?? new Prisma.Decimal(5000));
    const pricePerLesson = feeDec.div(billingDays);
    const grantedCost = new Prisma.Decimal(student.studentProfile.billingLessonsGranted).mul(feeDec).div(billingDays);
    const leftover = student.studentProfile.moneyBalance.sub(grantedCost);

    res.json({
      success: true,
      data: payments,
      monthly: {
        monthlyFee: monthlyFee != null ? monthlyFee.toString() : null,
        monthlyFeeEffective: (monthlyFee ?? basePrice)?.toString() ?? null,
        paidThisMonth: (paidAgg._sum.amount ?? 0).toString(),
        // som banked toward the next lesson (never negative)
        moneyBalance: (leftover.isNegative() ? new Prisma.Decimal(0) : leftover).toString(),
        pricePerLesson: pricePerLesson.toFixed(2),
      },
    });
  } catch (error) {
    log.error({ err: error }, 'students route error');
    res.status(500).json({ success: false, error: 'Failed to fetch payment history' });
  }
});

// GET /api/students/lookup?email= — Find student by email (or ?name= fallback) for schedule payment
router.get('/lookup', authenticate, requirePermission('students:read'), async (req: AuthRequest, res) => {
  try {
    const { email, name } = req.query;
    if (!email && !name) {
      return res.status(400).json({ success: false, error: 'email or name required' });
    }
    const schoolId = req.user!.schoolId;
    let student;
    if (email && typeof email === 'string') {
      student = await prisma.user.findFirst({
        where: { email, schoolId, role: Role.STUDENT, deletedAt: null },
        include: { studentProfile: true },
      });
    } else {
      const q = (name as string).trim();
      student = await prisma.user.findFirst({
        where: {
          schoolId, role: Role.STUDENT, deletedAt: null,
          OR: [
            { firstName: { contains: q, mode: 'insensitive' } },
            { lastName: { contains: q, mode: 'insensitive' } },
          ],
        },
        include: { studentProfile: true },
      });
    }
    if (!student?.studentProfile || student.studentProfile.deletedAt) {
      return res.status(404).json({ success: false, error: 'Student not found' });
    }
    res.json({
      success: true,
      data: {
        id: student.id,
        studentProfileId: student.studentProfile.id,
        name: `${student.firstName ?? ''} ${student.lastName ?? ''}`.trim(),
        email: student.email,
        credits: student.studentProfile.credits,
        paused: student.studentProfile.isFrozen,
      },
    });
  } catch (error: any) {
    log.error({ err: error }, 'students route error');
    sendLifecycleError(res, error, 'Failed to lookup student');
  }
});

// GET /api/students/by-profile/:profileId - Get student by StudentProfile.id (called from schedule)
router.get('/by-profile/:profileId', authenticate, requirePermission('students:read'), async (req: AuthRequest, res) => {
  try {
    const profileId = parseInt(req.params.profileId);
    const schoolId = req.user!.schoolId;

    const student = await prisma.user.findFirst({
      where: {
        schoolId,
        role: Role.STUDENT,
        deletedAt: null,
        studentProfile: { id: profileId, deletedAt: null },
      },
      select: {
        id: true, firstName: true, lastName: true, email: true, phone: true,
        studentProfile: {
          select: {
            id: true, level: true, chapter: true, credits: true, paidUntil: true,
            isFrozen: true, isVerified: true, notes: true,
            // Active GroupMembership is the enrollment source of truth (the legacy
            // StudentGroup.students/enrolledGroups relation is never written by any
            // production route — see scheduleValidation.ts). Mapped to `enrolledGroups`
            // below to keep the response shape the client already consumes.
            memberships: {
              where: { status: MemberStatus.ACTIVE, leftAt: null, studentGroup: { deletedAt: null } },
              select: {
                studentGroup: {
                  select: {
                    id: true, level: true,
                    blocks: {
                      where: { deletedAt: null },
                      orderBy: { type: 'asc' },
                      select: {
                        id: true, type: true, startTime: true, endTime: true, days: true,
                        cabinet: { select: { id: true, name: true } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!student) return res.status(404).json({ success: false, error: 'Student not found' });
    res.json({
      success: true,
      data: { ...student, studentProfile: mapEnrolledGroups(student.studentProfile) },
    });
  } catch (error) {
    log.error({ err: error }, 'students route error');
    res.status(500).json({ success: false, error: 'Failed to fetch student' });
  }
});

// GET /api/students/:id - Get single student with full profile (groups, blocks, cabinet)
router.get('/:id', authenticate, requirePermission('students:read'), async (req: AuthRequest, res) => {
  try {
    const userId = parseInt(req.params.id);
    const schoolId = req.user!.schoolId;

    const student = await prisma.user.findFirst({
      where: { id: userId, schoolId, role: Role.STUDENT, deletedAt: null },
      select: {
        id: true, firstName: true, lastName: true, email: true, phone: true, username: true,
        studentProfile: {
          select: {
            id: true, level: true, chapter: true, credits: true,
            isFrozen: true, isVerified: true, notes: true,
            // See /by-profile/:profileId above — GroupMembership is the enrollment
            // source of truth, mapped to `enrolledGroups` for the client.
            memberships: {
              where: { status: MemberStatus.ACTIVE, leftAt: null, studentGroup: { deletedAt: null } },
              select: {
                studentGroup: {
                  select: {
                    id: true, level: true,
                    blocks: {
                      where: { deletedAt: null },
                      orderBy: { type: 'asc' },
                      select: {
                        id: true, type: true, startTime: true, endTime: true, days: true,
                        cabinet: { select: { id: true, name: true } },
                        teacher: {
                          select: {
                            user: { select: { firstName: true, lastName: true } },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!student) return res.status(404).json({ success: false, error: 'Student not found' });
    res.json({
      success: true,
      data: { ...student, studentProfile: mapEnrolledGroups(student.studentProfile) },
    });
  } catch (error) {
    log.error({ err: error }, 'students route error');
    res.status(500).json({ success: false, error: 'Failed to fetch student' });
  }
});

// PATCH /api/students/:id/archive - Move student to archive (soft, reversible)
router.patch('/:id/archive', authenticate, requirePermission('students:write'), async (req: AuthRequest, res) => {
  try {
    const userId = parseInt(req.params.id);
    const schoolId = req.user!.schoolId!;

    const student = await prisma.user.findFirst({
      where: { id: userId, schoolId, role: Role.STUDENT, deletedAt: null, archivedAt: null },
      select: { id: true, firstName: true, lastName: true },
    });
    if (!student) return res.status(404).json({ success: false, error: 'Student not found or already archived' });

    await prisma.user.update({ where: { id: userId }, data: { archivedAt: new Date() } });

    log.info({ userId, schoolId, actorId: req.user!.userId }, 'Student archived');
    res.json({ success: true });
  } catch (error) {
    log.error({ err: error }, 'students archive error');
    res.status(500).json({ success: false, error: 'Failed to archive student' });
  }
});

// PATCH /api/students/:id/unarchive - Restore student from archive OR soft-delete.
// Clears archivedAt and deletedAt (User + StudentProfile) so the account returns to the
// active list. Soft-deleted groups are NOT resurrected — restored students keep their
// withdrawn memberships and must be re-enrolled explicitly.
router.patch('/:id/unarchive', authenticate, requirePermission('students:write'), async (req: AuthRequest, res) => {
  try {
    const userId = parseInt(req.params.id);
    const schoolId = req.user!.schoolId!;

    const student = await prisma.user.findFirst({
      where: {
        id: userId, schoolId, role: Role.STUDENT,
        OR: [{ archivedAt: { not: null } }, { deletedAt: { not: null } }],
      },
      select: { id: true, studentProfile: { select: { id: true } } },
    });
    if (!student) return res.status(404).json({ success: false, error: 'Student not found or not archived' });

    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { archivedAt: null, deletedAt: null } });
      if (student.studentProfile) {
        await tx.studentProfile.update({ where: { id: student.studentProfile.id }, data: { deletedAt: null } });
      }
    });

    log.info({ userId, schoolId, actorId: req.user!.userId }, 'Student restored from archive/soft-delete');
    res.json({ success: true });
  } catch (error) {
    log.error({ err: error }, 'students unarchive error');
    res.status(500).json({ success: false, error: 'Failed to unarchive student' });
  }
});

// PATCH /api/students/:id - Update student profile fields + optionally record payment or gift
router.patch('/:id', authenticate, requirePermission('students:write'), async (req: AuthRequest, res) => {
  try {
    const userId = parseInt(req.params.id);
    const schoolId = req.user!.schoolId!;
    const { isFrozen, reason, notes, paymentAmount, paymentMethod, paymentNote, paymentDate, giftLesson, monthlyFee } = req.body;

    if (monthlyFee !== undefined && monthlyFee !== null && (typeof monthlyFee !== 'number' || monthlyFee < 0)) {
      return res.status(400).json({ success: false, error: 'monthlyFee must be a non-negative number or null' });
    }
    const idempotencyKey = (req.headers['idempotency-key'] as string | undefined)?.trim();

    const isQuickPayment = typeof paymentAmount === 'number' && paymentAmount > 0;
    if (isQuickPayment && (!Number.isFinite(paymentAmount) || paymentAmount > 10_000_000)) {
      return res.status(400).json({ success: false, error: 'paymentAmount must be a finite number up to 10,000,000' });
    }
    // Optional backdate for the payment record (finance page lets the front desk
    // enter cash brought earlier). Stored as StudentPayment.createdAt — that column
    // is the payment date everywhere it is displayed.
    let paymentPaidAt: Date | undefined;
    if (isQuickPayment && paymentDate != null) {
      paymentPaidAt = new Date(paymentDate);
      if (isNaN(paymentPaidAt.getTime())) {
        return res.status(400).json({ success: false, error: 'paymentDate must be a valid date' });
      }
    }
    if (isQuickPayment && !idempotencyKey) {
      return res.status(400).json({
        success: false,
        error: 'Idempotency-Key header is required for student quick payment',
        code: 'IDEMPOTENCY_KEY_REQUIRED',
      });
    }

    // Recording a payment is a front-desk (ADMIN) task, so quick payment is allowed for
    // any students:write role. Gifting a free lesson stays OWNER/SUPERADMIN only, as does
    // cancelling/refunding a payment (see the cancel route below).
    if (giftLesson === true) {
      const role = req.user!.role;
      if (role !== 'OWNER' && role !== 'SUPERADMIN') {
        return res.status(403).json({
          success: false,
          error: 'Forbidden: giftLesson requires OWNER role',
          code: 'FINANCE_WRITE_REQUIRED',
        });
      }
    }

    const student = await prisma.user.findFirst({
      where: { id: userId, schoolId, role: Role.STUDENT, deletedAt: null },
      include: { studentProfile: true },
    });

    if (!student?.studentProfile || student.studentProfile.deletedAt) {
      return res.status(404).json({ success: false, error: 'Student not found' });
    }

    // Freeze/unfreeze goes through the lifecycle service (audit + notification + lifecycle event).
    // Handled separately from the main profileData transaction to keep lifecycle observability clean.
    if (isFrozen !== undefined) {
      const actor: LifecycleActor = {
        userId:   req.user!.userId,
        role:     req.user!.role,
        schoolId,
      };
      // ponytail: reason optional from the student card — keep the audit ledger populated with a sentinel
      const freezeReason = (typeof reason === 'string' && reason.trim()) ? reason.trim() : 'Без комментария';
      if (Boolean(isFrozen)) {
        // allowed + timesPerYear enforced in freezeService.createOpenEndedFreeze
        await applyFreeze({ studentProfileId: student.studentProfile.id, schoolId, actor, reason: freezeReason });
      } else {
        await reverseFreeze({ studentProfileId: student.studentProfile.id, schoolId, actor, reason: freezeReason });
      }
    }

    const profileData: Record<string, any> = {};
    if (notes !== undefined) profileData.notes = notes;
    if (monthlyFee !== undefined) profileData.monthlyFee = monthlyFee;

    const result = await prisma.$transaction(async (tx) => {
      let createdPayment: any = null;
      let isReplay = false;
      const updated = await tx.studentProfile.update({
        where: { id: student.studentProfile!.id },
        data: profileData,
      });

      // Finance config, loaded once for the price-change baseline and payment math.
      const config = await tx.schoolFinanceConfig.findUnique({ where: { schoolId } });
      const billingDays = config?.billingDays && config.billingDays > 0 ? config.billingDays : 26;
      const basePrice = config?.basePrice ?? new Prisma.Decimal(5000);

      // Price change draws a line: carry the sub-lesson leftover som forward at the
      // new price and reset the accumulator so only future money is billed at the new
      // rate. Lessons already granted are never re-judged. (updated.monthlyFee is the
      // NEW fee; the leftover is valued at the OLD fee the money was actually paid at.)
      const oldFeeNum = student.studentProfile!.monthlyFee != null ? Number(student.studentProfile!.monthlyFee) : null;
      const newFeeNum = monthlyFee != null ? monthlyFee : null;
      const feeChanged = monthlyFee !== undefined && oldFeeNum !== newFeeNum;
      if (feeChanged) {
        const oldFee = oldFeeNum && oldFeeNum > 0 ? new Prisma.Decimal(oldFeeNum) : basePrice;
        const grantedCost = new Prisma.Decimal(updated.billingLessonsGranted).mul(oldFee).div(billingDays);
        const leftover = updated.moneyBalance.sub(grantedCost);
        await tx.studentProfile.update({
          where: { id: student.studentProfile!.id },
          data: {
            moneyBalance: leftover.isNegative() ? new Prisma.Decimal(0) : leftover,
            billingLessonsGranted: 0,
          },
        });
      }

      // Подарок — 1 урок без оплаты
      if (giftLesson === true) {
        await tx.studentProfile.update({
          where: { id: student.studentProfile!.id },
          data: { credits: { increment: 1 } },
        });
        await tx.lessonCreditLog.create({
          data: {
            schoolId,
            studentProfileId: student.studentProfile!.id,
            amount: 1,
            reason: 'GIFT',
            type: 'GIFT',
            actorId: req.user!.userId,
          },
        });
      }

      // Оплата — считаем кредиты из суммы
      if (isQuickPayment) {
        if (idempotencyKey) {
          const existingStudentPayment = await tx.studentPayment.findUnique({
            where: { schoolId_idempotencyKey: { schoolId, idempotencyKey } },
          });
          if (existingStudentPayment) {
            // Replay: balance was already applied on the original call — return the
            // current persisted profile so the client reflects the real state.
            const freshReplay = await tx.studentProfile.findUnique({
              where: { id: student.studentProfile!.id },
            });
            return { updated: freshReplay ?? updated, createdPayment: existingStudentPayment, isReplay: true };
          }
        }

        // Proportional billing. Accumulate the payment into moneyBalance (never
        // decremented), then derive lessons from the running total with exact Decimal
        // math: owed = floor(totalPaid * billingDays / fee). So paying the full fee
        // buys exactly `billingDays` lessons, any amount is allowed, and the sub-lesson
        // remainder stays banked toward the next lesson — not a single som is lost.
        // The row lock this UPDATE takes also serializes concurrent payments per student.
        const banked = await tx.studentProfile.update({
          where: { id: student.studentProfile!.id },
          data: { moneyBalance: { increment: paymentAmount } },
          select: { moneyBalance: true, billingLessonsGranted: true, monthlyFee: true },
        });
        const fee = banked.monthlyFee != null && Number(banked.monthlyFee) > 0 ? banked.monthlyFee : basePrice;
        const owed = banked.moneyBalance.mul(billingDays).div(fee).floor().toNumber();
        const creditsToAdd = Math.max(0, owed - banked.billingLessonsGranted);
        const pricePerLesson = fee.div(billingDays); // effective per-lesson price, for the audit record

        if (creditsToAdd > 0) {
          await tx.studentProfile.update({
            where: { id: student.studentProfile!.id },
            data: {
              credits: { increment: creditsToAdd },
              billingLessonsGranted: owed,
            },
          });
        }

        const method: PaymentMethod =
          paymentMethod === 'TRANSFER' ? PaymentMethod.TRANSFER
          : paymentMethod === 'CARD'   ? PaymentMethod.CARD
          : PaymentMethod.CASH;

        createdPayment = await tx.studentPayment.create({
          data: {
            schoolId,
            studentProfileId: student.studentProfile!.id,
            creditsAdded: creditsToAdd,
            amount: paymentAmount,
            pricePerCredit: pricePerLesson,
            method,
            note: paymentNote?.trim() || null,
            createdById: req.user!.userId,
            idempotencyKey,
            ...(paymentPaidAt && { createdAt: paymentPaidAt }),
          },
        });

        // Money trace lives in StudentPayment; the credit ledger only records
        // payments that actually bought lessons (small banked amounts add 0).
        if (creditsToAdd > 0) {
          await tx.lessonCreditLog.create({
            data: {
              schoolId,
              studentProfileId: student.studentProfile!.id,
              amount: creditsToAdd,
              reason: 'PAYMENT',
              type: 'PAYMENT',
              actorId: req.user!.userId,
            },
          });
        }
      }

      // Balance changed (gift or quick payment) → re-derive display-only paidUntil.
      if (giftLesson === true || isQuickPayment) {
        await recomputeAndPersistPaidUntil(tx, student.studentProfile!.id, schoolId);
      }
      // Return the fresh profile whenever the balance or the billing accumulator moved
      // (a fee change resets moneyBalance/billingLessonsGranted) so the client reflects it.
      if (giftLesson === true || isQuickPayment || feeChanged) {
        const fresh = await tx.studentProfile.findUnique({
          where: { id: student.studentProfile!.id },
        });
        return { updated: fresh ?? updated, createdPayment, isReplay };
      }

      return { updated, createdPayment, isReplay };
    });

    if (result.createdPayment && !result.isReplay) {
      try {
        const [school, financeCfg] = await Promise.all([
          prisma.school.findUnique({ where: { id: schoolId }, select: { slug: true } }),
          prisma.schoolFinanceConfig.findUnique({ where: { schoolId }, select: { currency: true } }),
        ]);
        const schoolSlug = school?.slug || '';
        const currency = financeCfg?.currency || 'KGS';
        const studentName = `${student.firstName} ${student.lastName}`.trim();
        const amountNum = Number(paymentAmount);
        const isHighPriority = amountNum >= 10000;

        const payload = {
          schoolId,
          type: 'PAYMENT_CREATED',
          title: 'Получена оплата (быстрая)',
          body: `Сумма: ${amountNum} ${currency} от ${studentName}.`,
          category: 'FINANCE' as const,
          priority: isHighPriority ? ('HIGH' as const) : ('NORMAL' as const),
          entityType: 'StudentPayment',
          entityId: result.createdPayment.id,
          data: {
            studentName,
            amount: amountNum,
            method: paymentMethod,
          }
        };

        await notificationService.createForRole({
          ...payload,
          role: Role.OWNER,
          actionUrl: `/${schoolSlug}/owner/finance`,
        });

        await notificationService.createForRole({
          ...payload,
          role: Role.ADMIN,
          actionUrl: `/${schoolSlug}/admin/finance`,
        });
      } catch (err) {
        log.error({ err }, 'Failed to create student quick payment notification');
      }
    }

    // moneyBalance is the raw running total; expose the som banked toward the NEXT
    // lesson so the client wallet display is correct without a refetch.
    const out: any = result.updated;
    if (out) {
      const cfg = await prisma.schoolFinanceConfig.findUnique({ where: { schoolId }, select: { basePrice: true, billingDays: true } });
      const bDays = cfg?.billingDays && cfg.billingDays > 0 ? cfg.billingDays : 26;
      const feeD = out.monthlyFee != null && Number(out.monthlyFee) > 0
        ? new Prisma.Decimal(out.monthlyFee)
        : (cfg?.basePrice ?? new Prisma.Decimal(5000));
      const granted = new Prisma.Decimal(out.billingLessonsGranted ?? 0).mul(feeD).div(bDays);
      const lo = new Prisma.Decimal(out.moneyBalance).sub(granted);
      out.moneyBanked = (lo.isNegative() ? new Prisma.Decimal(0) : lo).toFixed(2);
      // Real DB id of the payment just created, so the client can cancel it
      // without a refetch instead of tracking it under a client-side placeholder id.
      if (result.createdPayment) out.paymentId = result.createdPayment.id;
    }
    res.json({ success: true, data: out });
  } catch (error: any) {
    // Concurrent requests with the same Idempotency-Key: both miss the replay
    // check, the loser fails the unique constraint. Return the winner's result
    // as a replay instead of a 500 — the payment was applied exactly once.
    if (error?.code === 'P2002') {
      const schoolId = req.user!.schoolId!;
      const key = (req.headers['idempotency-key'] as string | undefined)?.trim();
      if (key) {
        const existing = await prisma.studentPayment.findUnique({
          where: { schoolId_idempotencyKey: { schoolId, idempotencyKey: key } },
        });
        if (existing) {
          const fresh = await prisma.studentProfile.findUnique({ where: { id: existing.studentProfileId } });
          return res.json({ success: true, data: fresh });
        }
      }
    }
    log.error({ err: error }, 'students route error');
    sendLifecycleError(res, error, 'Failed to update student');
  }
});


// POST /api/students/:id/payments/:paymentId/cancel - Cancel/refund a recorded payment.
// Full reversal: removes every lesson the payment granted (balance may go negative if some
// were already used — the student then owes them). The original payment is kept and marked
// cancelled; a REFUND ledger entry is written and OWNER/ADMIN are notified. Allowed for any
// students:write role (ADMIN/OWNER/SUPERADMIN) — all payment handling is a front-desk task.
router.post('/:id/payments/:paymentId/cancel', authenticate, requirePermission('students:write'), async (req: AuthRequest, res) => {
  try {
    const userId = parseInt(req.params.id);
    const paymentId = parseInt(req.params.paymentId);
    // Postgres int4 column — a client-side placeholder id (e.g. Date.now()) overflows it
    // and would otherwise reach Prisma as an unhandled 500.
    if (!Number.isInteger(paymentId) || paymentId < 1 || paymentId > 2147483647) {
      return res.status(400).json({ success: false, error: 'Invalid payment id' });
    }
    const schoolId = req.user!.schoolId!;

    const student = await prisma.user.findFirst({
      where: { id: userId, schoolId, role: Role.STUDENT, deletedAt: null },
      include: { studentProfile: true },
    });
    if (!student?.studentProfile || student.studentProfile.deletedAt) {
      return res.status(404).json({ success: false, error: 'Student not found' });
    }

    const payment = await prisma.studentPayment.findFirst({
      where: { id: paymentId, schoolId, studentProfileId: student.studentProfile.id },
    });
    if (!payment) return res.status(404).json({ success: false, error: 'Payment not found' });
    if (payment.cancelledAt) return res.status(409).json({ success: false, error: 'Payment already cancelled' });

    const result = await prisma.$transaction(async (tx) => {
      // Reverse the accumulator by exactly what this payment added. Clamp at 0 so a
      // cancel after a later price change (which already rolled the money over) can't
      // drive the running total negative.
      // ponytail: clamp wipes any sub-lesson leftover in the rare cancel-after-price-change
      // case; acceptable (<1 lesson). Add pricing-epoch stamping if it ever matters.
      const profile = await tx.studentProfile.findUniqueOrThrow({
        where: { id: student.studentProfile!.id },
        select: { moneyBalance: true, billingLessonsGranted: true },
      });
      const newBalance = profile.moneyBalance.sub(payment.amount);
      await tx.studentProfile.update({
        where: { id: student.studentProfile!.id },
        data: {
          credits: { decrement: payment.creditsAdded }, // full reversal, may go negative
          moneyBalance: newBalance.isNegative() ? new Prisma.Decimal(0) : newBalance,
          billingLessonsGranted: Math.max(0, profile.billingLessonsGranted - payment.creditsAdded),
        },
      });

      const cancelled = await tx.studentPayment.update({
        where: { id: payment.id },
        data: { cancelledAt: new Date(), cancelledById: req.user!.userId },
      });

      await tx.lessonCreditLog.create({
        data: {
          schoolId,
          studentProfileId: student.studentProfile!.id,
          amount: -payment.creditsAdded,
          reason: 'PAYMENT_CANCELLED',
          type: 'REFUND',
          actorId: req.user!.userId,
        },
      });

      await recomputeAndPersistPaidUntil(tx, student.studentProfile!.id, schoolId);
      const fresh = await tx.studentProfile.findUnique({ where: { id: student.studentProfile!.id } });
      return { fresh, cancelled };
    });

    // Notify OWNER/ADMIN — mirrors the payment-created notification.
    try {
      const [school, financeCfg] = await Promise.all([
        prisma.school.findUnique({ where: { id: schoolId }, select: { slug: true } }),
        prisma.schoolFinanceConfig.findUnique({ where: { schoolId }, select: { currency: true } }),
      ]);
      const schoolSlug = school?.slug || '';
      const currency = financeCfg?.currency || 'KGS';
      const studentName = `${student.firstName} ${student.lastName}`.trim();
      const payload = {
        schoolId,
        type: 'PAYMENT_CANCELLED',
        title: 'Оплата отменена (возврат)',
        body: `Отменена оплата ${Number(payment.amount)} ${currency} для ${studentName} — списано ${payment.creditsAdded} уроков.`,
        category: 'FINANCE' as const,
        priority: 'HIGH' as const,
        entityType: 'StudentPayment',
        entityId: payment.id,
        data: { studentName, amount: Number(payment.amount), creditsRemoved: payment.creditsAdded },
      };
      await notificationService.createForRole({ ...payload, role: Role.OWNER, actionUrl: `/${schoolSlug}/owner/finance` });
      await notificationService.createForRole({ ...payload, role: Role.ADMIN, actionUrl: `/${schoolSlug}/admin/finance` });
    } catch (err) {
      log.error({ err }, 'Failed to create payment-cancelled notification');
    }

    const p: any = result.fresh;
    res.json({
      success: true,
      data: {
        credits: p?.credits,
        paidUntil: p?.paidUntil,
        cancelledPaymentId: payment.id,
      },
    });
  } catch (error: any) {
    log.error({ err: error }, 'students payment cancel error');
    sendLifecycleError(res, error, 'Failed to cancel payment');
  }
});

// PATCH /api/students/:id/payments/:paymentId/note — set/replace the payment's comment.
// Display-only metadata, no financial impact — plain update, allowed on cancelled rows too.
router.patch('/:id/payments/:paymentId/note', authenticate, requirePermission('students:write'), async (req: AuthRequest, res) => {
  try {
    const userId    = parseInt(req.params.id);
    const paymentId = parseInt(req.params.paymentId);
    const schoolId  = req.user!.schoolId!;
    const raw       = req.body?.note;

    if (raw != null && typeof raw !== 'string') {
      return res.status(400).json({ success: false, error: 'note must be a string or null' });
    }
    const note = raw?.trim() ? raw.trim().slice(0, 500) : null;

    const { count } = await prisma.studentPayment.updateMany({
      where: { id: paymentId, schoolId, studentProfile: { user: { id: userId } } },
      data:  { note },
    });
    if (count === 0) return res.status(404).json({ success: false, error: 'Payment not found' });
    res.json({ success: true, data: { id: paymentId, note } });
  } catch (error: any) {
    log.error({ err: error }, 'students payment note error');
    sendLifecycleError(res, error, 'Failed to update note');
  }
});

export default router;
