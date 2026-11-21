import { Router } from 'express';
import bcrypt from 'bcrypt';
import rateLimit from 'express-rate-limit';
import prisma from '../lib/prisma';
import { authenticate, AuthRequest } from '../middleware/authenticate';
import { requirePermission } from '../middleware/requirePermission';
import { Role, MemberStatus, Prisma } from '@prisma/client';
import { runChecks, Violation } from '../services/consistencyCheckService';
import { logScheduleAction } from '../lib/auditLog';
import { createLogger } from '../lib/logger';
import { syncSessionsForBlock } from '../services/sessionService';
import { emitToSchool } from '../lib/socket';
import { reconcileRosterOnMemberAdd } from '../services/rosterService';
import { recomputeAndPersistPaidUntil } from '../lib/paidUntilDerivation';

const log = createLogger('import');
const router = Router();

const importLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // max 10 imports per hour
  message: { success: false, error: 'Слишком много импортов. Попробуйте через час.' },
  standardHeaders: true,
  legacyHeaders: false,
});

function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email) && email.length <= 255;
}

function isValidName(name: string): boolean {
  if (!name || name.length < 1 || name.length > 100) return false;
  return /^[a-яa-z\s\-'\.]*$/i.test(name.trim());
}

function sanitizeString(s: string): string {
  return String(s).trim().substring(0, 100);
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_DAYS = 'Пн,Вт,Ср,Чт,Пт';
const DEFAULT_BLOCK_TYPE = 'GRAMMAR' as const;
const DEFAULT_MAX_STUDENTS = 15;
const DEFAULT_CHAPTER = 1;
const EXPORT_LIMIT_MAX = 10000;
const EXPORT_LIMIT_DEFAULT = 5000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function csvRow(fields: (string | number | boolean | null | undefined)[]): string {
  return fields.map(f => {
    const s = f == null ? '' : String(f);
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  }).join(',');
}

function buildCsv(headers: string[], rows: (string | number | boolean | null | undefined)[][]): string {
  return [csvRow(headers), ...rows.map(csvRow)].join('\n');
}

function sendCsv(res: any, filename: string, csv: string) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('﻿' + csv);
}

function parseTimeRange(time: string): { startTime: string; endTime: string } {
  if (!time) return { startTime: '', endTime: '' };
  // Normalize en dash (–), em dash (—), and regular hyphen to a common separator
  const normalized = time.replace(/–|—/g, '-');
  if (normalized.includes('-')) {
    const [s, e] = normalized.split('-').map(t => t.trim());
    return { startTime: s, endTime: e };
  }
  return { startTime: time.trim(), endTime: '' };
}

// ─── EXPORT ──────────────────────────────────────────────────────────────────

router.get('/export/students', authenticate, requirePermission('analytics:read'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user?.schoolId;

    const students = await prisma.user.findMany({
      where: { schoolId, role: Role.STUDENT, deletedAt: null },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        studentProfile: {
          select: {
            level: true,
            chapter: true,
            credits: true,
            isFrozen: true,
            // GroupMembership is the enrollment source of truth — the legacy
            // enrolledGroups relation is never written by any production route.
            memberships: {
              where: { status: MemberStatus.ACTIVE, leftAt: null },
              select: {
                studentGroup: {
                  select: {
                    blocks: {
                      where: { deletedAt: null },
                      select: {
                        type: true,
                        startTime: true,
                        endTime: true,
                        cabinet: { select: { name: true } },
                        teacher: { select: { user: { select: { firstName: true, lastName: true } } } },
                      },
                    },
                  },
                },
              },
            },
          }
        }
      },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    });

    const headers = ['Имя', 'Фамилия', 'Email', 'Телефон', 'Уровень', 'Глава', 'Кредиты', 'Заморожен', 'Групп', 'Преподаватель грамматики', 'Преподаватель разговорного клуба', 'Кабинет', 'Время'];
    const rows = students.map(s => {
      const grammarTeachers = new Set<string>();
      const clubTeachers = new Set<string>();
      const cabinets = new Set<string>();
      const times = new Set<string>();
      for (const m of s.studentProfile?.memberships ?? []) {
        for (const b of m.studentGroup?.blocks ?? []) {
          const teacherName = b.teacher?.user ? `${b.teacher.user.firstName} ${b.teacher.user.lastName}` : '';
          if (teacherName && b.type === 'GRAMMAR') grammarTeachers.add(teacherName);
          if (teacherName && b.type === 'SPEAKING_CLUB') clubTeachers.add(teacherName);
          if (b.cabinet?.name) cabinets.add(b.cabinet.name);
          if (b.startTime && b.endTime) times.add(`${b.startTime}-${b.endTime}`);
        }
      }
      return [
        s.firstName,
        s.lastName,
        s.email,
        s.phone || '',
        s.studentProfile?.level || '',
        s.studentProfile?.chapter ?? 1,
        s.studentProfile?.credits ?? 0,
        s.studentProfile?.isFrozen ? 'Да' : 'Нет',
        s.studentProfile?.memberships?.length ?? 0,
        [...grammarTeachers].join('; '),
        [...clubTeachers].join('; '),
        [...cabinets].join('; '),
        [...times].join('; '),
      ];
    });

    sendCsv(res, `students_${new Date().toISOString().slice(0, 10)}.csv`, buildCsv(headers, rows));
  } catch (err) {
    log.error({ err }, 'export students failed');
    res.status(500).json({ success: false, error: 'Export failed' });
  }
});

router.get('/export/teachers', authenticate, requirePermission('analytics:read'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user?.schoolId;

    const teachers = await prisma.user.findMany({
      where: { schoolId, role: Role.TEACHER, deletedAt: null },
      select: {
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        staffProfile: {
          select: {
            salaryRate: true,
            taughtBlocks: {
              where: { deletedAt: null },
              select: { id: true, level: true, status: true }
            }
          }
        }
      },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    });

    const headers = ['Имя', 'Фамилия', 'Email', 'Телефон', 'Ставка', 'Групп'];
    const rows = teachers.map(t => [
      t.firstName,
      t.lastName,
      t.email,
      t.phone || '',
      t.staffProfile?.salaryRate ? String(t.staffProfile.salaryRate) : '',
      t.staffProfile?.taughtBlocks?.length ?? 0,
    ]);

    sendCsv(res, `teachers_${new Date().toISOString().slice(0, 10)}.csv`, buildCsv(headers, rows));
  } catch (err) {
    log.error({ err }, 'export teachers failed');
    res.status(500).json({ success: false, error: 'Export failed' });
  }
});

router.get('/export/schedule', authenticate, requirePermission('analytics:read'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user?.schoolId;

    const blocks = await prisma.lessonBlock.findMany({
      where: { schoolId, deletedAt: null },
      select: {
        id: true,
        cabinet: { select: { name: true } },
        startTime: true,
        endTime: true,
        days: true,
        level: true,
        chapter: true,
        type: true,
        status: true,
        maxStudents: true,
        teacher: { select: { user: { select: { firstName: true, lastName: true } } } },
        studentGroup: { select: { memberships: { where: { status: 'ACTIVE' }, select: { id: true } } } },
        startDate: true,
        endDate: true,
      },
      orderBy: [{ startTime: 'asc' }],
    });

    const typeLabel: Record<string, string> = { GRAMMAR: 'Грамматика', SPEAKING_CLUB: 'Разг.клуб' };
    const statusLabel: Record<string, string> = { UPCOMING: 'Активен', COMPLETED: 'Завершён', CANCELLED: 'Отменён' };

    const headers = ['Кабинет', 'Начало', 'Конец', 'Дни', 'Уровень', 'Глава', 'Тип', 'Учитель', 'Студентов', 'Макс.', 'Статус', 'Начало курса', 'Конец курса'];
    const rows = blocks.map(b => [
      b.cabinet?.name || '',
      b.startTime,
      b.endTime,
      b.days.map((d: number) => (['Пн','Вт','Ср','Чт','Пт','Сб','Вс'][d] ?? d)).join(','),
      b.level,
      b.chapter,
      typeLabel[b.type] || b.type,
      b.teacher ? `${b.teacher.user.firstName} ${b.teacher.user.lastName}` : '',
      b.studentGroup?.memberships.length ?? 0,
      b.maxStudents,
      statusLabel[b.status] || b.status,
      b.startDate ? b.startDate.toISOString().slice(0, 10) : '',
      b.endDate ? b.endDate.toISOString().slice(0, 10) : '',
    ]);

    sendCsv(res, `schedule_${new Date().toISOString().slice(0, 10)}.csv`, buildCsv(headers, rows));
  } catch (err) {
    log.error({ err }, 'export schedule failed');
    res.status(500).json({ success: false, error: 'Export failed' });
  }
});

router.get('/export/attendance', authenticate, requirePermission('analytics:read'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user?.schoolId;

    const { from, to } = req.query as { from?: string; to?: string };
    const dateFrom = from ? new Date(from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const dateTo = to ? new Date(to) : new Date();

    const attendances = await prisma.attendance.findMany({
      where: {
        schoolId,
        lessonSession: { date: { gte: dateFrom, lte: dateTo } },
      },
      select: {
        status: true,
        creditDeducted: true,
        lessonSession: {
          select: {
            date: true,
            lessonBlock: { select: { cabinet: { select: { name: true } }, startTime: true, type: true, level: true } }
          }
        },
        studentProfile: {
          select: {
            level: true,
            user: { select: { firstName: true, lastName: true, email: true } },
          }
        },
      },
      orderBy: { lessonSession: { date: 'desc' } },
    });

    const statusLabel: Record<string, string> = { PRESENT: 'Присутствовал', ABSENT: 'Отсутствовал', LATE: 'Опоздал' };
    const typeLabel: Record<string, string> = { GRAMMAR: 'Грамматика', SPEAKING_CLUB: 'Разг.клуб' };

    const headers = ['Дата', 'Студент', 'Email', 'Уровень', 'Кабинет', 'Время', 'Тип', 'Статус', 'Кредит списан'];
    const rows = attendances.map(a => {
      const block = a.lessonSession?.lessonBlock;
      return [
        a.lessonSession?.date.toISOString().slice(0, 10) || '',
        `${a.studentProfile.user.firstName} ${a.studentProfile.user.lastName}`,
        a.studentProfile.user.email,
        a.studentProfile.level || '',
        block?.cabinet?.name || '',
        block?.startTime || '',
        block ? (typeLabel[block.type] || block.type) : '',
        statusLabel[a.status] || a.status,
        a.creditDeducted ? 'Да' : 'Нет',
      ];
    });

    sendCsv(res, `attendance_${new Date().toISOString().slice(0, 10)}.csv`, buildCsv(headers, rows));
  } catch (err) {
    log.error({ err }, 'export attendance failed');
    res.status(500).json({ success: false, error: 'Export failed' });
  }
});

router.get('/export/salary', authenticate, requirePermission('analytics:read'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user?.schoolId;

    const { from, to } = req.query as { from?: string; to?: string };
    const dateFrom = from ? new Date(from) : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const dateTo = to ? new Date(to) : new Date();

    const teachers = await prisma.user.findMany({
      where: { schoolId, role: Role.TEACHER, deletedAt: null },
      select: {
        firstName: true,
        lastName: true,
        email: true,
        staffProfile: {
          select: {
            salaryRate: true,
            substitutions: {
              where: { date: { gte: dateFrom, lte: dateTo }, status: 'COMPLETED', deletedAt: null },
              select: { id: true }
            },
            taughtBlocks: {
              where: { deletedAt: null },
              select: {
                sessions: {
                  where: {
                    date: { gte: dateFrom, lte: dateTo },
                    status: 'COMPLETED',
                    deletedAt: null,
                    teacherId: null,
                  },
                  select: { id: true }
                }
              }
            }
          }
        }
      },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    });

    const headers = ['Преподаватель', 'Email', 'Ставка', 'Уроков', 'Замены', 'Итого уроков', 'К выплате'];
    const rows = teachers.map(t => {
      const lessons = (t.staffProfile?.taughtBlocks || []).reduce((sum: any, b: any) => sum + b.sessions.length, 0);
      const subs = t.staffProfile?.substitutions?.length || 0;
      const total = lessons + subs;
      const rate = t.staffProfile?.salaryRate ? Number(t.staffProfile.salaryRate) : 0;
      return [
        `${t.firstName} ${t.lastName}`,
        t.email,
        rate || '',
        lessons,
        subs,
        total,
        rate ? rate * total : '',
      ];
    });

    sendCsv(res, `salary_${new Date().toISOString().slice(0, 10)}.csv`, buildCsv(headers, rows));
  } catch (err) {
    log.error({ err }, 'export salary failed');
    res.status(500).json({ success: false, error: 'Export failed' });
  }
});

router.get('/export/backup', authenticate, requirePermission('analytics:read'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user?.schoolId;

    const [school, students, teachers, blocks, sessions, attendances, creditLogs] = await Promise.all([
      prisma.school.findUnique({ where: { id: schoolId! }, select: { id: true, name: true, slug: true, city: true, timezone: true } }),
      prisma.user.findMany({
        where: { schoolId, role: Role.STUDENT, deletedAt: null },
        select: { id: true, firstName: true, lastName: true, email: true, phone: true,
          studentProfile: { select: { level: true, chapter: true, credits: true, isFrozen: true } } }
      }),
      prisma.user.findMany({
        where: { schoolId, role: Role.TEACHER, deletedAt: null },
        select: { id: true, firstName: true, lastName: true, email: true, phone: true,
          staffProfile: { select: { salaryRate: true } } }
      }),
      prisma.lessonBlock.findMany({
        where: { schoolId, deletedAt: null },
        select: { id: true, cabinetId: true, startTime: true, endTime: true, days: true, level: true,
          chapter: true, type: true, status: true, maxStudents: true, teacherId: true, startDate: true, endDate: true }
      }),
      prisma.lessonSession.findMany({
        where: { schoolId, deletedAt: null },
        select: { id: true, lessonBlockId: true, date: true, status: true, teacherId: true }
      }),
      prisma.attendance.findMany({
        where: { schoolId },
        select: { id: true, lessonSessionId: true, studentProfileId: true, status: true, creditDeducted: true }
      }),
      prisma.lessonCreditLog.findMany({
        where: { schoolId },
        select: { id: true, studentProfileId: true, amount: true, reason: true, createdAt: true }
      }),
    ]);

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="backup_${new Date().toISOString().slice(0, 10)}.json"`);
    res.send(JSON.stringify({ exportedAt: new Date().toISOString(), school, students, teachers, lessonBlocks: blocks, lessonSessions: sessions, attendances, creditLogs }, null, 2));
  } catch (err) {
    log.error({ err }, 'export backup failed');
    res.status(500).json({ success: false, error: 'Export failed' });
  }
});

// ─── IMPORT ──────────────────────────────────────────────────────────────────

router.post('/import/preview', authenticate, requirePermission('data:import'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user?.schoolId;

    const { students } = req.body as {
      students: Array<{ firstName: string; lastName: string; email: string; phone?: string; level?: string; chapter?: number; credits?: number }>;
    };

    if (!Array.isArray(students) || students.length === 0) {
      return res.status(400).json({ success: false, error: 'No student data provided' });
    }

    const emails = students.map(s => s.email?.toLowerCase()).filter(Boolean);
    const existing = await prisma.user.findMany({
      where: { email: { in: emails }, schoolId, deletedAt: null },
      select: {
        id: true, firstName: true, lastName: true, email: true, phone: true,
        studentProfile: { select: { level: true, chapter: true, credits: true } }
      }
    });

    const existingMap = new Map(existing.map(e => [e.email!.toLowerCase(), e]));
    const conflicts: any[] = [];
    let newCount = 0;

    for (const s of students) {
      const email = s.email?.toLowerCase();
      if (!email) continue;
      const ex = existingMap.get(email);
      if (ex) conflicts.push({ email, existing: ex, incoming: s });
      else newCount++;
    }

    res.json({ success: true, data: { conflicts, newCount, total: students.length } });
  } catch (err) {
    log.error({ err }, 'import preview failed');
    res.status(500).json({ success: false, error: 'Preview failed' });
  }
});

router.post('/import/apply', authenticate, requirePermission('data:import'), importLimiter, async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user?.schoolId;
    const dryRun = req.query.dryRun === 'true';

    const { students, resolutions = {}, defaultPassword } = req.body as {
      students: Array<{
        firstName: string; lastName: string; email: string; phone?: string;
        level?: string; chapter?: number; credits?: number; paidUntil?: string;
        cabinet?: string; time?: string; grammarTeacher?: string; clubTeacher?: string; paused?: boolean | string;
        notes?: string;
      }>;
      resolutions: Record<string, 'update' | 'skip'>;
      defaultPassword?: string;
    };

    if (!Array.isArray(students) || students.length === 0) {
      return res.status(400).json({ success: false, error: 'No student data provided' });
    }

    // Also rejects '' — previously falsy defaultPassword skipped this check
    // entirely and bcrypt.hash('', 10) created accounts with an empty password.
    if (!defaultPassword || defaultPassword.length < 8) {
      return res.status(400).json({ success: false, error: 'Password must be at least 8 characters' });
    }

    function parsePaused(val: any): boolean {
      if (!val) return false;
      const v = String(val).toLowerCase().trim();
      return v === 'true' || v === '1' || v === 'да' || v === 'yes';
    }

    // paused=true in a CSV row sets StudentProfile.isFrozen (display cache), but
    // that flag alone doesn't stop credit deduction — attendanceService only
    // checks live StudentFreeze rows (CLAUDE.md: isFrozen is legacy-cache-only).
    // Without this, an imported "frozen" student still gets charged on attendance.
    // Only ever creates (paused=true); paused=false on an update is intentionally
    // a no-op here, matching the existing isFrozen write's own asymmetry — import
    // doesn't unfreeze a student who was frozen through the real freeze flow.
    async function ensureImportFreeze(tx: Prisma.TransactionClient, studentProfileId: number) {
      const existing = await tx.studentFreeze.findFirst({
        where: { studentProfileId, schoolId: schoolId!, status: 'ACTIVE' },
        select: { id: true },
      });
      if (existing) return;
      await tx.studentFreeze.create({
        data: {
          schoolId: schoolId!,
          studentProfileId,
          type: 'PERIOD',
          startDate: new Date(),
          endDate: null,
          reason: 'Импорт CSV (paused)',
          createdById: req.user!.userId,
        },
      });
    }

    // Создаём учителей из колонок grammarTeacher и clubTeacher
    const teacherNamesInFile = new Set<string>();
    for (const s of students) {
      if (s.grammarTeacher) teacherNamesInFile.add(s.grammarTeacher.trim());
      if (s.clubTeacher) teacherNamesInFile.add(s.clubTeacher.trim());
    }

    let schoolTeachers = await prisma.user.findMany({
      where: { schoolId: schoolId!, role: Role.TEACHER },
      select: { id: true, firstName: true, lastName: true, deletedAt: true, staffProfile: { select: { id: true } } }
    });
    const existingTeacherNames = new Set(
      schoolTeachers.filter(t => t.deletedAt === null).map(t => `${t.firstName} ${t.lastName}`.toLowerCase())
    );
    const softDeletedTeachersByName = new Map(
      schoolTeachers.filter(t => t.deletedAt !== null).map(t => [`${t.firstName} ${t.lastName}`.toLowerCase(), t])
    );

    if (!dryRun && teacherNamesInFile.size > 0) {
      const teacherPassword = await bcrypt.hash(defaultPassword, 10);
      for (const fullName of teacherNamesInFile) {
        if (!fullName || existingTeacherNames.has(fullName.toLowerCase())) continue;
        const parts = fullName.trim().split(/\s+/);
        const firstName = parts[0];
        const lastName = parts.slice(1).join(' ') || '';

        const softDeletedMatch = softDeletedTeachersByName.get(fullName.toLowerCase());
        if (softDeletedMatch) {
          await prisma.user.update({ where: { id: softDeletedMatch.id }, data: { deletedAt: null, firstName, lastName } });
          if (softDeletedMatch.staffProfile) {
            await prisma.staffProfile.update({ where: { id: softDeletedMatch.staffProfile.id }, data: { deletedAt: null } });
          }
          schoolTeachers.push({ ...softDeletedMatch, deletedAt: null });
          existingTeacherNames.add(fullName.toLowerCase());
          continue;
        }

        const placeholderEmail = `teacher.import.${schoolId}.${existingTeacherNames.size}@import.local`;
        try {
          const existingByEmail = await prisma.user.findFirst({ where: { email: placeholderEmail, schoolId }, select: { id: true, deletedAt: true, staffProfile: { select: { id: true } } } });
          if (existingByEmail) {
            await prisma.user.update({ where: { id: existingByEmail.id }, data: { deletedAt: null, firstName, lastName } });
            if (existingByEmail.staffProfile) {
              await prisma.staffProfile.update({ where: { id: existingByEmail.staffProfile.id }, data: { deletedAt: null } });
            }
            schoolTeachers.push({ id: existingByEmail.id, firstName, lastName, deletedAt: null, staffProfile: existingByEmail.staffProfile });
            existingTeacherNames.add(fullName.toLowerCase());
          } else {
            const newTeacher = await prisma.user.create({
              data: { firstName, lastName, email: placeholderEmail, password: teacherPassword, role: Role.TEACHER, schoolId: schoolId! },
              select: { id: true, firstName: true, lastName: true }
            });
            const staffProfile = await prisma.staffProfile.create({ data: { userId: newTeacher.id } });
            schoolTeachers.push({ ...newTeacher, deletedAt: null, staffProfile: { id: staffProfile.id } });
            existingTeacherNames.add(fullName.toLowerCase());
          }
        } catch (err: any) {
          log.error({ err, teacherName: fullName }, 'error creating teacher during import');
        }
      }
    }

    const emails = students.map(s => s.email?.toLowerCase()).filter(Boolean);
    const existing = await prisma.user.findMany({
      where: { email: { in: emails }, schoolId, deletedAt: null },
      select: { id: true, email: true, studentProfile: { select: { id: true, credits: true } } }
    });
    const existingMap = new Map(existing.map(e => [e.email!.toLowerCase(), e]));

    let created = 0, updated = 0, skipped = 0, wouldCreateCreditLogs = 0;
    const errors: string[] = [];
    // paidUntil is derived from the credit balance (single writer:
    // recomputeAndPersistPaidUntil) — dates from the file are never applied.
    if (students.some((s) => (s as any).paidUntil)) {
      errors.push('[INFO] Колонка paidUntil игнорируется — дата «оплачено до» рассчитывается автоматически из баланса уроков');
    }
    const profileIdByEmail = new Map<string, number>();
    const hashedPassword = await bcrypt.hash(defaultPassword, 10);

    log.info({ schoolId, dryRun, students: students.length, existingCount: existingMap.size, resolutionKeys: Object.keys(resolutions).length }, 'import apply started');

    for (const s of students) {
      const email = s.email?.toLowerCase();
      if (!email || !s.firstName) { errors.push(`Пропущена строка: ${JSON.stringify(s)}`); continue; }
      if (!isValidEmail(email)) { errors.push(`Невалидный email: ${email}`); continue; }
      if (!isValidName(s.firstName)) { errors.push(`Невалидное имя: ${s.firstName}`); continue; }
      if (s.lastName && !isValidName(s.lastName)) { errors.push(`Невалидная фамилия: ${s.lastName}`); continue; }
      if (s.chapter && s.chapter <= 0) { errors.push(`Chapter должен быть > 0: ${email}`); continue; }
      // Negative credits are valid — they represent lesson debt (deferred payment model).
      if (s.credits && s.credits > 0 && !s.level && !s.cabinet) {
        errors.push(`[WARN] ${email}: credits импортированы без level/cabinet — проверьте источник`);
      }

      const ex = existingMap.get(email);

      if (ex) {
        const resolution = resolutions[email] || 'skip';
        if (resolution === 'skip') {
          skipped++;
          if (ex.studentProfile) profileIdByEmail.set(email, ex.studentProfile.id);
          continue;
        }
        if (dryRun) {
          updated++;
          if (ex.studentProfile) profileIdByEmail.set(email, ex.studentProfile.id);
        } else {
          try {
            await prisma.$transaction(async (tx) => {
              await tx.user.update({
                where: { id: ex.id },
                data: {
                  firstName: s.firstName, lastName: s.lastName, phone: s.phone || undefined,
                  studentProfile: ex.studentProfile ? {
                    update: {
                      level: s.level || undefined, chapter: s.chapter ?? undefined,
                      isFrozen: parsePaused((s as any).paused) || undefined,
                      notes: s.notes || undefined,
                    }
                  } : undefined,
                }
              });
              if (ex.studentProfile && parsePaused((s as any).paused)) {
                await ensureImportFreeze(tx, ex.studentProfile.id);
              }
              // Credits update with audit trail — done separately to create a CORRECTION log
              if (ex.studentProfile && s.credits !== undefined && s.credits !== ex.studentProfile.credits) {
                const delta = s.credits - (ex.studentProfile.credits ?? 0);
                await tx.studentProfile.update({
                  where: { id: ex.studentProfile.id },
                  data: { credits: s.credits },
                });
                await tx.lessonCreditLog.create({
                  data: {
                    schoolId: schoolId!,
                    studentProfileId: ex.studentProfile.id,
                    amount: delta,
                    reason: 'Коррекция баланса (импорт)',
                    type: 'CORRECTION',
                    actorId: req.user?.userId ?? null,
                  },
                });
                // Balance changed → re-derive display-only paidUntil in the same tx.
                await recomputeAndPersistPaidUntil(tx, ex.studentProfile.id, schoolId!);
              }
            });
            if (ex.studentProfile) profileIdByEmail.set(email, ex.studentProfile.id);
            updated++;
          } catch (e: any) {
            errors.push(`Ошибка обновления ${email}: ${e.message}`);
          }
        }
      } else {
        if (dryRun) {
          created++;
          if (s.credits && s.credits > 0) wouldCreateCreditLogs++;
        } else {
          try {
            // Check BEFORE transaction: user with this email in THIS school (active or soft-deleted)?
            const emailOwner = await prisma.user.findFirst({
              where: { email, schoolId },
              select: { id: true, deletedAt: true, schoolId: true, studentProfile: { select: { id: true, credits: true } } },
            });
            // Login identifiers are per-school, so the same email may exist in
            // another school — that's fine, no cross-school block.
            if (emailOwner) {
              // Exists in this school — restore regardless of deletedAt (handles both active and soft-deleted)
              const restoredProfile = await prisma.$transaction(async (tx) => {
                await tx.user.update({
                  where: { id: emailOwner.id },
                  data: { deletedAt: null, firstName: s.firstName, lastName: s.lastName, phone: s.phone || undefined },
                });
                if (emailOwner.studentProfile) {
                  await tx.studentProfile.update({
                    where: { id: emailOwner.studentProfile.id },
                    data: {
                      deletedAt: null,
                      level: s.level || undefined, chapter: s.chapter ?? undefined,
                      isFrozen: parsePaused((s as any).paused) || undefined,
                      notes: s.notes || undefined,
                      ...(s.credits !== undefined ? { credits: s.credits } : {}),
                    },
                  });
                  if (parsePaused((s as any).paused)) {
                    await ensureImportFreeze(tx, emailOwner.studentProfile.id);
                  }
                  if (s.credits !== undefined && s.credits > 0) {
                    await tx.lessonCreditLog.create({
                      data: {
                        schoolId: schoolId!, studentProfileId: emailOwner.studentProfile.id,
                        sessionId: null, amount: s.credits,
                        reason: 'Начальный баланс (импорт)', type: 'IMPORT',
                        actorId: req.user?.userId ?? null,
                      },
                    });
                  }
                  if (s.credits !== undefined) {
                    // Balance changed → re-derive display-only paidUntil in the same tx.
                    await recomputeAndPersistPaidUntil(tx, emailOwner.studentProfile.id, schoolId!);
                  }
                }
                return emailOwner.studentProfile;
              });
              if (restoredProfile) profileIdByEmail.set(email, restoredProfile.id);
              created++;
            } else {
              const newUser = await prisma.$transaction(async (tx) => {
                const user = await tx.user.create({
                  data: {
                    firstName: s.firstName, lastName: s.lastName, email,
                    password: hashedPassword, role: Role.STUDENT, schoolId: schoolId!,
                    phone: s.phone || undefined,
                    studentProfile: {
                      create: {
                        level: s.level || '', chapter: s.chapter ?? 1,
                        credits: s.credits ?? 0,
                        isFrozen: parsePaused((s as any).paused),
                        notes: s.notes || undefined,
                      }
                    }
                  },
                  include: { studentProfile: { select: { id: true } } }
                });
                if (user.studentProfile && parsePaused((s as any).paused)) {
                  await ensureImportFreeze(tx, user.studentProfile.id);
                }
                if (s.credits && s.credits > 0 && user.studentProfile) {
                  await tx.lessonCreditLog.create({
                    data: {
                      schoolId: schoolId!, studentProfileId: user.studentProfile.id,
                      sessionId: null, amount: s.credits,
                      reason: 'Начальный баланс (импорт)', type: 'IMPORT',
                      actorId: req.user?.userId ?? null,
                    },
                  });
                  // Positive starting balance → derive the initial paidUntil.
                  await recomputeAndPersistPaidUntil(tx, user.studentProfile.id, schoolId!);
                }
                return user;
              });
              if (newUser.studentProfile) profileIdByEmail.set(email, newUser.studentProfile.id);
              created++;
            }
          } catch (e: any) {
            errors.push(`Ошибка создания ${email}: ${e.message}`);
          }
        }
      }
    }

    // Dry-run: возвращаем preview без записи в БД
    if (dryRun) {
      return res.json({ success: true, data: {
        dryRun: true,
        preview: { wouldCreate: created, wouldUpdate: updated, wouldSkip: skipped,
                   wouldCreateCreditLogs, errors },
        total: students.length,
      }});
    }

    // Зачисление в группы по кабинету + времени
    const studentsWithBlock = students.filter(s => s.cabinet && s.time);
    if (studentsWithBlock.length > 0) {
      function matchTeacher(name?: string): number | null {
        if (!name) return null;
        const n = name.trim().toLowerCase();
        const teacher = schoolTeachers.find(t =>
          `${t.firstName} ${t.lastName}`.toLowerCase() === n ||
          `${t.lastName} ${t.firstName}`.toLowerCase() === n
        );
        return teacher?.staffProfile?.id ?? null;
      }

      const blockGroups = new Map<string, {
        cabinetName: string; startTime: string; endTime: string;
        level: string; chapter: number; grammarTeacherName?: string; clubTeacherName?: string; profileIds: number[];
      }>();

      for (const s of studentsWithBlock) {
        const email = s.email?.toLowerCase();
        const profileId = email ? profileIdByEmail.get(email) : undefined;
        if (!profileId) continue;

        const { startTime, endTime } = parseTimeRange(s.time!);
        // Include level in key so different levels at same cabinet+time get separate groups
        const key = `${s.cabinet}::${startTime}::${s.level || ''}`;

        if (!blockGroups.has(key)) {
          blockGroups.set(key, {
            cabinetName: s.cabinet!, startTime, endTime,
            level: s.level || '', chapter: s.chapter ?? 1,
            grammarTeacherName: s.grammarTeacher, clubTeacherName: s.clubTeacher,
            profileIds: [],
          });
        }
        blockGroups.get(key)!.profileIds.push(profileId);
      }

      for (const grp of blockGroups.values()) {
        try {
          const grammarTeacherId = matchTeacher(grp.grammarTeacherName) ?? undefined;
          const clubTeacherId = matchTeacher(grp.clubTeacherName) ?? undefined;

          // Найти или создать кабинет
          let cabinet = await prisma.cabinet.findFirst({
            where: { name: grp.cabinetName, schoolId: schoolId!, deletedAt: null }
          });
          if (!cabinet) {
            cabinet = await prisma.cabinet.create({
              data: { name: grp.cabinetName, schoolId: schoolId! }
            });
          }

          // Найти или создать TimeSlot
          let importSlot = await prisma.timeSlot.findUnique({
            where: { schoolId_startTime_endTime: { schoolId: schoolId!, startTime: grp.startTime, endTime: grp.endTime } },
          });
          if (!importSlot) {
            const maxOrd = await prisma.timeSlot.aggregate({ where: { schoolId: schoolId! }, _max: { order: true } });
            importSlot = await prisma.timeSlot.create({
              data: { schoolId: schoolId!, startTime: grp.startTime, endTime: grp.endTime, order: (maxOrd._max.order ?? 0) + 1 },
            });
          }

          // Найти или создать StudentGroup для этой комбинации уровень+кабинет+слот.
          // Must include cabinetId: multiple cabinets can share the same TimeSlot record
          // (TimeSlot is school-wide), so omitting cabinetId causes all same-time cabinets
          // to collapse into one group.
          let studentGroup = await prisma.studentGroup.findFirst({
            where: {
              schoolId: schoolId!, deletedAt: null,
              ...(grp.level ? { level: grp.level } : {}),
              blocks: { some: { timeSlotId: importSlot.id, cabinetId: cabinet.id, deletedAt: null } },
            },
          });
          if (!studentGroup) {
            studentGroup = await prisma.studentGroup.create({
              data: {
                schoolId: schoolId!,
                level: grp.level, chapter: grp.chapter,
                maxStudents: 15, status: 'ACTIVE',
              },
            });
          }

          // Найти или создать GRAMMAR блок (Пн/Ср/Пт = days [0,2,4])
          // Also search by old en-dash/em-dash startTime from a previous buggy import
          let block = await prisma.lessonBlock.findFirst({
            where: {
              schoolId: schoolId!, cabinetId: cabinet.id, type: 'GRAMMAR', deletedAt: null,
              OR: [
                { startTime: grp.startTime },
                { startTime: `${grp.startTime}–${grp.endTime}` },
                { startTime: `${grp.startTime}—${grp.endTime}` },
              ],
            },
          });

          let grammarBlockCreated = false;
          if (!block) {
            grammarBlockCreated = true;
            block = await prisma.lessonBlock.create({
              data: {
                schoolId: schoolId!, cabinetId: cabinet.id,
                timeSlotId: importSlot.id,
                startTime: grp.startTime, endTime: grp.endTime,
                days: [0, 2, 4], level: grp.level, chapter: grp.chapter,
                maxStudents: 15, type: 'GRAMMAR',
                teacherId: grammarTeacherId ?? null,
                studentGroupId: studentGroup.id,
                startDate: new Date(),
              },
            });
          } else {
            // Обновить fields; also migrate malformed startTime/endTime from old import
            const updateData: any = {};
            if (grammarTeacherId) updateData.teacherId = grammarTeacherId;
            if (!block.studentGroupId) updateData.studentGroupId = studentGroup.id;
            if (block.startTime !== grp.startTime || block.endTime !== grp.endTime) {
              updateData.startTime = grp.startTime;
              updateData.endTime = grp.endTime;
              updateData.timeSlotId = importSlot.id;
            }
            if (Object.keys(updateData).length > 0) {
              await prisma.lessonBlock.update({ where: { id: block.id }, data: updateData });
              block = { ...block, ...updateData };
            }
          }

          // Записать студентов в StudentGroup
          const existingMembers = await prisma.groupMembership.findMany({
            where: { studentGroupId: studentGroup.id, status: 'ACTIVE' },
            select: { studentProfileId: true },
          });
          const enrolledIds = new Set(existingMembers.map(m => m.studentProfileId));
          const toEnroll = grp.profileIds.filter((id: number) => !enrolledIds.has(id));

          if (toEnroll.length > 0) {
            const now = new Date();
            await Promise.all(
              toEnroll.map((id: number) =>
                prisma.groupMembership.upsert({
                  where: { studentProfileId_studentGroupId: { studentProfileId: id, studentGroupId: studentGroup.id } },
                  create: { schoolId: schoolId!, studentProfileId: id, studentGroupId: studentGroup.id, joinedAt: now, status: 'ACTIVE' },
                  update: { status: 'ACTIVE', leftAt: null, joinedAt: now },
                })
              )
            );
            // Snapshot newly enrolled students into upcoming sessions (same as UI enroll flow)
            await reconcileRosterOnMemberAdd(studentGroup.id, schoolId!, toEnroll);
          }

          // Generate rolling-window sessions for the grammar block if it was just created
          if (grammarBlockCreated && block) {
            await syncSessionsForBlock(block);
          }

          // Найти или создать SPEAKING_CLUB блок (Вт/Чт/Сб = days [1,3,5])
          if (grp.clubTeacherName || clubTeacherId !== undefined) {
            let clubBlock = await prisma.lessonBlock.findFirst({
              where: {
                schoolId: schoolId!, cabinetId: cabinet.id, type: 'SPEAKING_CLUB', deletedAt: null,
                OR: [
                  { startTime: grp.startTime },
                  { startTime: `${grp.startTime}–${grp.endTime}` },
                  { startTime: `${grp.startTime}—${grp.endTime}` },
                ],
              },
            });

            if (!clubBlock) {
              const newClubBlock = await prisma.lessonBlock.create({
                data: {
                  schoolId: schoolId!, cabinetId: cabinet.id,
                  timeSlotId: importSlot.id,
                  studentGroupId: studentGroup.id,
                  startTime: grp.startTime, endTime: grp.endTime,
                  days: [1, 3, 5], level: grp.level, chapter: grp.chapter,
                  maxStudents: 15, type: 'SPEAKING_CLUB',
                  teacherId: clubTeacherId ?? null,
                  startDate: new Date(),
                },
              });
              await syncSessionsForBlock(newClubBlock);
            } else {
              const clubUpdate: any = {};
              if (clubTeacherId !== undefined) clubUpdate.teacherId = clubTeacherId;
              if (!clubBlock.studentGroupId) clubUpdate.studentGroupId = studentGroup.id;
              if (clubBlock.startTime !== grp.startTime || clubBlock.endTime !== grp.endTime) {
                clubUpdate.startTime = grp.startTime;
                clubUpdate.endTime = grp.endTime;
                clubUpdate.timeSlotId = importSlot.id;
              }
              if (Object.keys(clubUpdate).length > 0) {
                await prisma.lessonBlock.update({ where: { id: clubBlock.id }, data: clubUpdate });
              }
            }
          }
        } catch (e: any) {
          errors.push(`Ошибка группы ${grp.cabinetName} ${grp.startTime}: ${e.message}`);
        }
      }

      // Normalize timeslots: remove orphaned malformed slots from previous buggy imports,
      // then re-sort remaining slots by startTime so they appear in chronological order.
      if (schoolId) {
        try {
          // Delete timeslots that have no blocks and contain en/em dash in startTime
          // (artifact of the previous parseTimeRange bug)
          await prisma.timeSlot.deleteMany({
            where: {
              schoolId: schoolId!,
              blocks: { none: {} },
              OR: [
                { startTime: { contains: '–' } },
                { startTime: { contains: '—' } },
              ],
            },
          });

          // Re-sort all remaining timeslots by startTime (HH:MM sorts correctly as string)
          const allSchoolSlots = await prisma.timeSlot.findMany({
            where: { schoolId: schoolId! },
            orderBy: { startTime: 'asc' },
            select: { id: true },
          });
          await Promise.all(
            allSchoolSlots.map((sl, i) =>
              prisma.timeSlot.update({ where: { id: sl.id }, data: { order: i + 1 } })
            )
          );
        } catch (e: any) {
          errors.push(`Предупреждение: не удалось пересортировать слоты: ${e.message}`);
        }
      }
    }

    let consistencyCheck: { clean: boolean; violations: Violation[] } = { clean: true, violations: [] };
    if (schoolId) {
      try {
        const violations = await runChecks(schoolId, prisma);
        consistencyCheck = { clean: violations.length === 0, violations };
        if (violations.length > 0) {
          log.warn({ event: 'POST_IMPORT_VIOLATIONS', schoolId,
            criticalCount: violations.filter(v => v.severity === 'CRITICAL').length,
            total: violations.length }, 'Consistency violations found after import');
        }
      } catch (checkErr: any) {
        log.warn({ event: 'CONSISTENCY_CHECK_FAILED', schoolId, err: checkErr.message },
          'Post-import consistency check threw — check skipped');
      }
    }

    // Audit trail — bulk imports are high-risk operations
    if (schoolId && !dryRun) {
      logScheduleAction({
        client: prisma,
        schoolId,
        userId: req.user!.userId,
        action: 'BULK_IMPORT_STUDENTS',
        entityType: 'import' as any,
        after: { created, updated, skipped, total: students.length },
      }).catch(() => {});
    }

    // Notify connected Schedule clients to reload (same signal as UI block/student mutations)
    if (!dryRun && schoolId && (created > 0 || updated > 0)) {
      emitToSchool(schoolId, 'schedule:structure-changed', { action: 'bulk-import' });
    }

    res.json({ success: true, data: { created, updated, skipped, errors, total: students.length, consistencyCheck } });
  } catch (err) {
    log.error({ err }, 'POST /import/apply');
    res.status(500).json({ success: false, error: 'Import failed' });
  }
});

router.post('/import/preview-teachers', authenticate, requirePermission('users:manage'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user?.schoolId;

    const { teachers } = req.body as {
      teachers: Array<{ firstName: string; lastName: string; email: string; phone?: string }>;
    };

    if (!Array.isArray(teachers) || teachers.length === 0) {
      return res.status(400).json({ success: false, error: 'No teacher data provided' });
    }

    const emails = teachers.map(t => t.email?.toLowerCase()).filter(Boolean);
    const existing = await prisma.user.findMany({
      where: { email: { in: emails }, schoolId, deletedAt: null },
      select: { id: true, firstName: true, lastName: true, email: true, phone: true, role: true }
    });

    const existingMap = new Map(existing.map(e => [e.email!.toLowerCase(), e]));
    const conflicts: any[] = [];
    let newCount = 0;

    for (const t of teachers) {
      const email = t.email?.toLowerCase();
      if (!email) continue;
      if (existingMap.get(email)) conflicts.push({ email, existing: existingMap.get(email), incoming: t });
      else newCount++;
    }

    res.json({ success: true, data: { conflicts, newCount, total: teachers.length } });
  } catch (err) {
    log.error({ err }, 'preview teachers failed');
    res.status(500).json({ success: false, error: 'Preview failed' });
  }
});

router.post('/import/apply-teachers', authenticate, requirePermission('users:manage'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user?.schoolId;

    const { teachers, resolutions = {}, defaultPassword } = req.body as {
      teachers: Array<{ firstName: string; lastName: string; email: string; phone?: string }>;
      resolutions: Record<string, 'update' | 'skip'>;
      defaultPassword?: string;
    };

    if (!Array.isArray(teachers) || teachers.length === 0) {
      return res.status(400).json({ success: false, error: 'No teacher data provided' });
    }

    // Also rejects '' — previously falsy defaultPassword skipped this check
    // entirely and bcrypt.hash('', 10) created accounts with an empty password.
    if (!defaultPassword || defaultPassword.length < 8) {
      return res.status(400).json({ success: false, error: 'Password must be at least 8 characters' });
    }

    const emails = teachers.map(t => t.email?.toLowerCase()).filter(Boolean);
    const existing = await prisma.user.findMany({
      where: { email: { in: emails }, schoolId, deletedAt: null },
      select: { id: true, email: true }
    });
    const existingMap = new Map(existing.map(e => [e.email!.toLowerCase(), e]));

    let created = 0, updated = 0, skipped = 0;
    const errors: string[] = [];
    const hashedPassword = await bcrypt.hash(defaultPassword, 10);

    for (const t of teachers) {
      const email = t.email?.toLowerCase();
      if (!email || !t.firstName || !t.lastName) { errors.push(`Пропущена строка: ${JSON.stringify(t)}`); continue; }
      if (!isValidEmail(email)) { errors.push(`Невалидный email: ${email}`); continue; }
      if (!isValidName(t.firstName)) { errors.push(`Невалидное имя: ${t.firstName}`); continue; }
      if (!isValidName(t.lastName)) { errors.push(`Невалидная фамилия: ${t.lastName}`); continue; }

      const ex = existingMap.get(email);
      if (ex) {
        if ((resolutions[email] || 'skip') === 'skip') { skipped++; continue; }
        try {
          await prisma.$transaction(async (tx) => {
            return tx.user.update({ where: { id: ex.id }, data: { firstName: t.firstName, lastName: t.lastName, phone: t.phone || undefined } });
          });
          updated++;
        } catch (e: any) {
          errors.push(`Ошибка обновления ${email}: ${e.message}`);
        }
      } else {
        try {
          await prisma.$transaction(async (tx) => {
            const newUser = await tx.user.create({
              data: { firstName: t.firstName, lastName: t.lastName, email, password: hashedPassword, role: Role.TEACHER, schoolId: schoolId!, phone: t.phone || undefined }
            });
            await tx.staffProfile.create({ data: { userId: newUser.id } });
          });
          created++;
        } catch (e: any) {
          errors.push(`Ошибка создания ${email}: ${e.message}`);
        }
      }
    }

    // Audit trail
    if (schoolId) {
      logScheduleAction({
        client: prisma,
        schoolId,
        userId: req.user!.userId,
        action: 'BULK_IMPORT_TEACHERS',
        entityType: 'import' as any,
        after: { created, updated, skipped, total: teachers.length },
      }).catch(() => {});
    }

    res.json({ success: true, data: { created, updated, skipped, errors, total: teachers.length } });
  } catch (err) {
    log.error({ err }, 'POST /import/apply-teachers');
    res.status(500).json({ success: false, error: 'Import failed' });
  }
});

export default router;
