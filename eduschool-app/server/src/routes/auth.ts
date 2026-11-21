import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { OAuth2Client } from 'google-auth-library';
import prisma from '../lib/prisma';
import { authenticate, AuthRequest } from '../middleware/authenticate';
import { Role } from '@prisma/client';
import { sendVerificationEmail, sendPasswordResetEmail, sendWelcomeEmail } from '../lib/email';
import { createLogger } from '../lib/logger';
import { invalidateUserCache } from '../lib/userCache';
import { getPolicyForDate } from '../services/policyService';
import { ALLOWED_ORIGINS } from '../lib/allowedOrigins';
import { getPasswordError } from '../lib/passwordPolicy';
import { ACCESS_TOKEN_TTL } from '../lib/jwtSecret';
import { logSecurityEvent } from '../lib/auditLog';

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const log = createLogger('auth');
const router = Router();
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('JWT_SECRET is not set in environment variables');

// Максимум 10 попыток логина с одного IP за 15 минут
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, error: 'Слишком много попыток входа. Попробуйте через 15 минут.' },
  standardHeaders: true,
  legacyHeaders: false,
  // DEV-LOGIN-SHORTCUTS: temporary dev-only bypass for localhost login limiter. DELETE before prod.
  // Bundled with the DEV Autologin buttons in client/src/pages/Login.tsx — delete both together.
  // Find every piece: grep -r "DEV-LOGIN-SHORTCUTS"
  // Never skip in test (CI runs on localhost and asserts the limiter) or production.
  skip: (req) =>
    process.env.NODE_ENV !== 'production' &&
    process.env.NODE_ENV !== 'test' &&
    ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.ip ?? ''),
});

// Максимум 3 регистрации с одного IP за час
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  message: { success: false, error: 'Слишком много попыток регистрации. Попробуйте через час.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Максимум 20 попыток входа через Google с одного IP за 15 минут
const googleAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, error: 'Слишком много попыток входа через Google. Попробуйте через 15 минут.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Максимум 3 запроса повторной верификации с одного IP за час
const resendVerificationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  message: { success: false, error: 'Слишком много попыток. Попробуйте через час.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const REFRESH_COOKIE = 'rt';
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Cookie attributes for the refresh token. In production the client and API are
// separate Railway services on different origins, so the cookie must be
// SameSite=None + Secure or the browser silently drops it on cross-site requests.
// Locally we stay on Lax over http. `set` and `clear` MUST use identical
// attributes or the browser refuses to remove the cookie on logout.
const REFRESH_COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: (process.env.NODE_ENV === 'production' ? 'none' : 'lax') as 'none' | 'lax',
  path: '/',
};
// CSRF defense for /refresh and /logout: they authenticate via the `rt` cookie
// alone (no Authorization header), so a cross-site page can trigger them.
// Every other endpoint requires a Bearer token a cross-site request can't attach.
// Browsers always set Origin on cross-origin POST, so checking it (falling back
// to Referer) blocks forged requests without a full CSRF token scheme.
function requireTrustedOrigin(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin ?? req.headers.referer;
  if (origin && !ALLOWED_ORIGINS.some(allowed => origin.startsWith(allowed))) {
    res.status(403).json({ success: false, error: 'Forbidden origin' });
    return;
  }
  next();
}

const TRIAL_DAYS = 7;
const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

// Fixed-cost placeholder hash so a login with an unknown identifier takes the same
// time as one with a known identifier + wrong password — otherwise the early return
// on "no matching account" is a timing oracle for enumerating valid emails/phones/usernames.
const DUMMY_HASH_PROMISE = bcrypt.hash('timing-attack-mitigation-placeholder', 10);

async function issueRefreshCookie(userId: number, res: Response): Promise<void> {
  const token = crypto.randomBytes(64).toString('hex');
  const expiresAt = new Date(Date.now() + REFRESH_TTL_MS);

  // Multi-device login: each login gets its own refresh token, other active
  // sessions are left alone (no single-active-session policy). Theft protection
  // comes from rotation + reuse-detection in /refresh, not from killing siblings here.
  await prisma.refreshToken.create({ data: { token, userId, expiresAt } });

  res.cookie(REFRESH_COOKIE, token, { ...REFRESH_COOKIE_OPTS, maxAge: REFRESH_TTL_MS });
}

// Practical (non-GOST) Cyrillic→Latin map, includes Kyrgyz-specific letters (ң, ө, ү)
// since schools register in Kyrgyzstan (Asia/Bishkek, KGS).
const CYRILLIC_TO_LATIN: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
  й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '',
  э: 'e', ю: 'yu', я: 'ya', ң: 'ng', ө: 'o', ү: 'u',
};

function transliterate(text: string): string {
  return text.toLowerCase().split('').map(ch => CYRILLIC_TO_LATIN[ch] ?? ch).join('');
}

function generateSlug(name: string): string {
  return transliterate(name)
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

router.post('/register-school', registerLimiter, async (req, res) => {
  try {
    let { schoolName, city, phone, adminFirstName, adminLastName, email, password } = req.body;
    email = email.toLowerCase().trim();

    const passwordError = getPasswordError(password);
    if (passwordError) {
      return res.status(400).json({ success: false, error: passwordError });
    }

    const existingUser = await prisma.user.findFirst({ where: { email } });
    if (existingUser) {
      if (existingUser.deletedAt) {
        return res.status(400).json({ success: false, error: 'Этот email уже привязан к удаленному аккаунту. Обратитесь в поддержку.' });
      }
      return res.status(400).json({ success: false, error: 'Email already in use' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const sName = schoolName || `Школа ${adminFirstName || 'Специалиста'}`;
    let baseSlug = generateSlug(sName);
    if (!baseSlug || baseSlug === '-') {
      baseSlug = 'school';
    }

    let slug = baseSlug;
    let counter = 2;
    while (await prisma.school.findFirst({ where: { slug, deletedAt: null } })) {
      slug = `${baseSlug}-${counter}`;
      counter++;
    }

    const verificationToken = crypto.randomBytes(32).toString('hex');
    const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const school = await prisma.school.create({
      data: {
        name: sName,
        city: city || 'Не указан',
        phone,
        email,
        slug,
        activeDays: [],
        users: {
          create: {
            email,
            password: hashedPassword,
            firstName: adminFirstName || 'Без Имени',
            lastName: adminLastName || 'Без Фамилии',
            phone,
            role: Role.OWNER,
            emailVerified: false,
            verificationToken,
            verificationExpires
          }
        }
      },
      include: {
        users: true
      }
    });

    const user = school.users[0];

    await prisma.staffProfile.create({ data: { userId: user.id } });

    const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
    const graceEndsAt = new Date(trialEndsAt.getTime() + 3 * 24 * 60 * 60 * 1000);

    await prisma.subscription.create({
      data: {
        schoolId: school.id,
        plan: 'TRIAL',
        status: 'TRIALING',
        trialEndsAt,
        graceEndsAt,
      },
    });

    // Отправляем письмо верификации + приветственное
    const emailResult = await sendVerificationEmail(user.email!, verificationToken);
    sendWelcomeEmail(user.email!, user.firstName, school.name, school.slug).catch(() => {});

    await issueRefreshCookie(user.id, res);

    res.json({
      success: true,
      message: 'Письмо с подтверждением отправлено на email',
      data: {
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          role: user.role,
          schoolId: school.id
        },
        school: {
          id: school.id,
          name: school.name,
          slug: slug,
          city: school.city,
          onboardingCompleted: school.onboardingCompleted,
          onboardingStep: school.onboardingStep,
          onboardingCompletedAt: school.onboardingCompletedAt?.toISOString() || null
        },
        devVerifyLink: process.env.NODE_ENV === 'development' ? (emailResult.data as any)?.verifyLink : undefined
      }
    });
  } catch (error) {
    if ((error as any).code === 'P2002') {
      const target = (error as any).meta?.target;
      if (target?.includes('slug')) {
        return res.status(400).json({ success: false, error: 'Произошла ошибка при генерации адреса школы. Пожалуйста, попробуйте еще раз.' });
      }
      if (target?.includes('email')) {
        return res.status(400).json({ success: false, error: 'Этот email уже используется' });
      }
    }
    log.error({ err: error }, 'auth route error');
    res.status(500).json({ success: false, error: 'Internal server error during registration' });
  }
});

router.post('/login', loginLimiter, async (req, res) => {
  try {
    let { email, identifier, password, slug } = req.body;
    // Login accepts any of the three per-school identifiers: email, phone, or
    // username. `identifier` is the new field; `email` is kept for backward
    // compatibility with existing clients.
    const rawId = String(identifier ?? email ?? '').trim();
    if (!rawId || !password) {
      return res.status(400).json({ success: false, error: 'Введите логин и пароль' });
    }
    const lowerId = rawId.toLowerCase(); // email/username are stored lowercased

    // Resolve within the school tenant when a slug is present (regular users
    // always log in via /:slug/login). SUPERADMIN has no school and logs in
    // globally by email/username.
    const where: any = {
      deletedAt: null,
      OR: [{ email: lowerId }, { username: lowerId }, { phone: rawId }],
    };
    if (slug) {
      const school = await prisma.school.findFirst({ where: { slug, deletedAt: null } });
      if (!school) {
        return res.status(401).json({ success: false, error: 'Неверный логин или пароль' });
      }
      where.schoolId = school.id;
    }

    // phone is not unique (siblings can share one family phone — see students.ts
    // POST /), and without a slug the same email/username/phone can legitimately
    // belong to different people in different schools. Load all candidates and
    // only proceed on an unambiguous match rather than guessing with findFirst.
    const candidates = await prisma.user.findMany({
      where,
      include: { school: true },
      omit: { password: false }, // needed for bcrypt.compare below
    });
    if (candidates.length > 1) {
      return res.status(409).json({
        success: false,
        error: slug
          ? 'Этот телефон используется у нескольких учеников. Войдите по личному логину.'
          : 'Этот логин используется в нескольких школах. Пожалуйста, войдите по ссылке вашей школы.',
      });
    }
    const user = candidates[0];

    if (!user) {
      await bcrypt.compare(password, await DUMMY_HASH_PROMISE);
      await logSecurityEvent({ event: 'LOGIN_FAILED', details: { identifier: lowerId, reason: 'no_matching_account' }, req });
      return res.status(401).json({ success: false, error: 'Неверный логин или пароль' });
    }

    // SUPERADMIN не привязан к школе — slug проверяем только для обычных пользователей
    if (user.role !== Role.SUPERADMIN) {
      if (slug && user.school?.slug !== slug) {
        return res.status(403).json({ success: false, error: 'Этот пользователь не принадлежит данной школе' });
      }
      if (user.school) {
        const school = user.school as any;
        const blockedAt: Date | null = school.blockedAt ?? null;
        if (blockedAt) {
          const blockDeadline = new Date(blockedAt);
          blockDeadline.setDate(blockDeadline.getDate() + 7);
          // Блокируем только после истечения 7 дней с момента blockedAt
          if (new Date() > blockDeadline) {
            return res.status(403).json({ success: false, error: 'Доступ к школе закрыт. Обратитесь к администратору.' });
          }
        }
        // isActive больше не проверяем при логине — используется только blockedAt
      }
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      await logSecurityEvent({ event: 'LOGIN_FAILED', schoolId: user.schoolId, userId: user.id, details: { reason: 'wrong_password' }, req });
      return res.status(401).json({ success: false, error: 'Неверный email или пароль' });
    }

    // ponytail: email verification gate disabled — no email provider is configured
    // yet, so verification mail never arrives and users get locked out. Re-enable
    // once RESEND_API_KEY points at a real provider.
    // if (user.email && !user.emailVerified && user.role !== Role.SUPERADMIN) {
    //   return res.status(403).json({ success: false, error: 'EMAIL_NOT_VERIFIED' });
    // }

    if (user.twoFactorEnabled) {
      const tempToken = jwt.sign(
        { userId: user.id, isTemp2FA: true },
        JWT_SECRET,
        { expiresIn: '15m' }
      );

      return res.json({
        success: true,
        data: {
          requires2fa: true,
          tempToken,
        }
      });
    }

    const token = jwt.sign(
      { userId: user.id, schoolId: user.schoolId ?? null, role: user.role, tokenVersion: user.tokenVersion },
      JWT_SECRET,
      { expiresIn: ACCESS_TOKEN_TTL }
    );

    await issueRefreshCookie(user.id, res);

    res.json({
      success: true,
      data: {
        token,
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          role: user.role,
          schoolId: user.schoolId ?? null
        },
        school: user.school ? {
          id: user.school.id,
          name: user.school.name,
          slug: user.school.slug,
          city: user.school.city,
          onboardingCompleted: user.school.onboardingCompleted,
          onboardingStep: user.school.onboardingStep,
          onboardingCompletedAt: user.school.onboardingCompletedAt?.toISOString() || null
        } : null
      }
    });
  } catch (error) {
    log.error({ err: error }, 'auth route error');
    res.status(500).json({ success: false, error: 'Internal server error during login' });
  }
});

router.get('/me', authenticate, async (req: AuthRequest, res) => {
  try {
    const userId = req.user?.userId;
    const user = await prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      include: {
        school: { include: { subscription: true } },
        studentProfile: true,
      },
    });

    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    const policy = user.school ? await getPolicyForDate(user.school.id, new Date()) : null;

    res.json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          role: user.role,
          schoolId: user.schoolId ?? null,
          twoFactorEnabled: user.twoFactorEnabled,
          studentProfile: user.studentProfile ? {
            id: user.studentProfile.id,
            credits: user.studentProfile.credits,
            level: user.studentProfile.level
          } : undefined
        },
        school: user.school ? {
          id: user.school.id,
          name: user.school.name,
          slug: user.school.slug,
          city: user.school.city,
          blockedAt: (user.school as any).blockedAt ?? null,
          onboardingCompleted: user.school.onboardingCompleted,
          onboardingStep: user.school.onboardingStep,
          onboardingCompletedAt: user.school.onboardingCompletedAt?.toISOString() || null,
          activeDays: policy?.activeDays ?? [],
          workStart: policy?.workStart ?? null,
          workEnd: policy?.workEnd ?? null,
          slotDuration: policy?.slotDuration ?? null,
          subscription: (user.school as any).subscription
            ? {
                status: (user.school as any).subscription.status,
                plan: (user.school as any).subscription.plan,
                trialEndsAt: (user.school as any).subscription.trialEndsAt ?? null,
                graceEndsAt: (user.school as any).subscription.graceEndsAt ?? null,
                paidUntil: (user.school as any).subscription.paidUntil ?? null,
              }
            : null,
        } : null
      }
    });
  } catch (error) {
    log.error({ err: error }, 'auth route error');
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

router.post('/register-student', registerLimiter, async (req, res) => {
  try {
    let { slug, firstName, lastName, email, password } = req.body;
    if (email) email = email.toLowerCase().trim();

    if (!slug || typeof slug !== 'string') {
      return res.status(400).json({ success: false, error: 'Адрес школы обязателен' });
    }

    // Public self-signup must carry a verifiable email — email-less accounts are
    // only created by trusted admins via the users endpoint.
    if (!email) {
      return res.status(400).json({ success: false, error: 'Email обязателен для регистрации' });
    }

    const passwordError = getPasswordError(password);
    if (passwordError) {
      return res.status(400).json({ success: false, error: passwordError });
    }

    const school = await prisma.school.findFirst({ where: { slug, deletedAt: null } });
    if (!school) {
      return res.status(404).json({ success: false, error: 'Школа не найдена' });
    }

    const existingUser = await prisma.user.findFirst({ where: { email, schoolId: school.id } });
    if (existingUser) {
      if (existingUser.deletedAt) {
        return res.status(400).json({ success: false, error: 'Этот email уже привязан к удаленному аккаунту. Обратитесь в поддержку.' });
      }
      return res.status(400).json({ success: false, error: 'Email уже зарегистрирован' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const verificationToken = crypto.randomBytes(32).toString('hex');
    const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const user = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        firstName: firstName || 'Без Имени',
        lastName: lastName || 'Без Фамилии',
        role: Role.STUDENT,
        schoolId: school.id,
        emailVerified: false,
        verificationToken,
        verificationExpires,
        studentProfile: {
          create: {
            credits: 0
          }
        }
      }
    });

    const emailResult = await sendVerificationEmail(user.email!, verificationToken);

    await issueRefreshCookie(user.id, res);

    res.json({
      success: true,
      message: 'Письмо с подтверждением отправлено на email',
      data: {
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          role: user.role,
          schoolId: school.id
        },
        school: {
          id: school.id,
          name: school.name,
          slug: school.slug,
          city: school.city
        },
        devVerifyLink: process.env.NODE_ENV === 'development' ? (emailResult.data as any)?.verifyLink : undefined
      }
    });
  } catch (error) {
    log.error({ err: error }, 'student registration error');
    res.status(500).json({ success: false, error: 'Internal server error during student registration' });
  }
});


router.post('/google', googleAuthLimiter, async (req, res) => {
  try {
    const { credential, context = 'login', slug } = req.body;
    if (req.body.token || req.body.access_token) {
      return res.status(400).json({ success: false, error: 'Google id_token credential is required' });
    }
    if (!credential || typeof credential !== 'string') {
      return res.status(400).json({ success: false, error: 'Google id_token credential is required' });
    }

    // Verify only Google id_token credentials; access_token/userinfo is not trusted here.
    let email: string;
    let given_name: string | undefined;
    let family_name: string | undefined;
    try {
      const ticket = await googleClient.verifyIdToken({
        idToken: credential,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      const payload = ticket.getPayload();
      const audienceOk = payload?.aud === process.env.GOOGLE_CLIENT_ID;
      const issuerOk = Boolean(payload?.iss && GOOGLE_ISSUERS.has(payload.iss));
      const expiresAt = typeof payload?.exp === 'number' ? payload.exp * 1000 : 0;
      const notExpired = expiresAt > Date.now();
      if (!payload || !audienceOk || !issuerOk || !notExpired || !payload.email_verified || !payload.email) {
        return res.status(401).json({ success: false, error: 'Invalid Google token' });
      }
      email = payload.email.toLowerCase().trim();
      given_name = payload.given_name;
      family_name = payload.family_name;
    } catch {
      return res.status(401).json({ success: false, error: 'Invalid Google token' });
    }

    let user = await prisma.user.findFirst({
      where: { email },
      include: { school: true }
    });

    if (user && user.deletedAt) {
      return res.status(400).json({ success: false, error: 'Этот email привязан к удаленному аккаунту. Обратитесь в поддержку.' });
    }

    if (user) {
      // User exists - check context constraints
      if (user.role !== Role.SUPERADMIN) {
        if (slug && user.school?.slug !== slug) {
          return res.status(403).json({ success: false, error: 'Этот пользователь не принадлежит данной школе' });
        }
        if (user.school) {
          const school = user.school as any;
          const blockedAt: Date | null = school.blockedAt ?? null;
          if (blockedAt) {
            const blockDeadline = new Date(blockedAt);
            blockDeadline.setDate(blockDeadline.getDate() + 7);
            if (new Date() > blockDeadline) {
              return res.status(403).json({ success: false, error: 'Доступ к школе закрыт. Обратитесь к администратору.' });
            }
          }
        }
      }
    } else {
      // User does not exist
      if (context === 'register-school') {
        const schoolName = `Школа ${given_name || 'Специалиста'}`;
        let baseSlug = generateSlug(schoolName);
        if (!baseSlug || baseSlug === '-') {
          baseSlug = 'school';
        }
        let generatedSlug = baseSlug;
        let counter = 2;
        while (await prisma.school.findFirst({ where: { slug: generatedSlug, deletedAt: null } })) {
          generatedSlug = `${baseSlug}-${counter}`;
          counter++;
        }

        // Generate a random secure password for Google users
        const randomPassword = await bcrypt.hash(Math.random().toString(36).slice(-10) + Date.now().toString(), 10);

        const school = await prisma.school.create({
          data: {
            name: schoolName,
            slug: generatedSlug,
            city: 'Не указан',
            email: email,
            activeDays: [],
            users: {
              create: {
                email,
                password: randomPassword,
                firstName: given_name || 'Без Имени',
                lastName: family_name || 'Без Фамилии',
                role: Role.OWNER,
                emailVerified: true
              }
            }
          },
          include: {
            users: true
          }
        });
        user = school.users[0] as any;
        if (user) {
          (user as any).school = school as any;
        }
        await prisma.staffProfile.create({ data: { userId: user!.id } });

        // Unified 7-day trial subscription
        const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
        const graceEndsAt = new Date(trialEndsAt.getTime() + 3 * 24 * 60 * 60 * 1000);
        await prisma.subscription.create({
          data: {
            schoolId: school.id,
            plan: 'TRIAL',
            status: 'TRIALING',
            trialEndsAt,
            graceEndsAt,
          },
        });
      } else if (context === 'school-login') {
        return res.status(404).json({ success: false, error: 'Аккаунт в этой школе не найден. Обратитесь к администратору или используйте приглашение.' });
      } else if (context === 'student-register') {
        return res.status(400).json({ success: false, error: 'Регистрация студентов через Google не поддерживается.' });
      } else {
        // Default: 'login'
        return res.status(404).json({ success: false, error: 'Аккаунт не найден. Зарегистрируйте школу или войдите по приглашению.' });
      }
    }

    if (!user) {
      return res.status(500).json({ success: false, error: 'User could not be initialized' });
    }

    if (user.twoFactorEnabled) {
      const tempToken = jwt.sign(
        { userId: user.id, isTemp2FA: true },
        JWT_SECRET,
        { expiresIn: '15m' }
      );

      return res.json({
        success: true,
        data: {
          requires2fa: true,
          tempToken,
        }
      });
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
        school: user.school ? {
          id: (user.school as any).id,
          name: (user.school as any).name,
          slug: (user.school as any).slug,
          city: (user.school as any).city,
          onboardingCompleted: (user.school as any).onboardingCompleted,
          onboardingStep: (user.school as any).onboardingStep,
          onboardingCompletedAt: (user.school as any).onboardingCompletedAt?.toISOString() || null
        } : null
      }
    });

  } catch (error) {
    if ((error as any).code === 'P2002') {
      const target = (error as any).meta?.target;
      if (target?.includes('slug')) {
        return res.status(400).json({ success: false, error: 'Произошла ошибка при генерации адреса школы. Пожалуйста, попробуйте еще раз.' });
      }
      if (target?.includes('email')) {
        return res.status(400).json({ success: false, error: 'Этот email уже используется' });
      }
    }
    log.error({ err: error }, 'Google auth error');
    res.status(500).json({ success: false, error: 'Internal server error during Google auth' });
  }
});

// POST /auth/refresh — issue new access token using HttpOnly refresh cookie
router.post('/refresh', requireTrustedOrigin, async (req: Request, res: Response) => {
  const rawToken = req.cookies?.[REFRESH_COOKIE] as string | undefined;
  if (!rawToken) {
    return res.status(401).json({ success: false, error: 'No refresh token' });
  }

  try {
    const stored = await prisma.refreshToken.findUnique({
      where: { token: rawToken },
      include: { user: true },
    });

    if (!stored) {
      res.clearCookie(REFRESH_COOKIE, REFRESH_COOKIE_OPTS);
      return res.status(401).json({ success: false, error: 'Invalid refresh token' });
    }

    // Reuse detection — token was already revoked
    if (stored.revokedAt) {
      const GRACE_MS = 5_000;
      const revokedMsAgo = Date.now() - stored.revokedAt.getTime();

      if (revokedMsAgo <= GRACE_MS) {
        // Multi-tab race: another tab rotated this token < 5s ago — issue a new access token only
        const { user } = stored;
        if (user.deletedAt) {
          return res.status(401).json({ success: false, error: 'Account deleted' });
        }
        const accessToken = jwt.sign(
          { userId: user.id, schoolId: user.schoolId ?? null, role: user.role, tokenVersion: user.tokenVersion },
          JWT_SECRET,
          { expiresIn: ACCESS_TOKEN_TTL }
        );
        return res.json({ success: true, data: { token: accessToken } });
      }

      // Suspicious reuse outside grace window — revoke ALL active tokens for this user
      await prisma.refreshToken.updateMany({
        where: { userId: stored.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      res.clearCookie(REFRESH_COOKIE, REFRESH_COOKIE_OPTS);
      await logSecurityEvent({
        event: 'TOKEN_REUSE_DETECTED',
        schoolId: stored.user.schoolId,
        userId: stored.userId,
        details: { reason: 'all_sessions_revoked' },
        req,
      });
      return res.status(401).json({ success: false, error: 'Refresh token reuse detected' });
    }

    if (stored.expiresAt < new Date()) {
      res.clearCookie(REFRESH_COOKIE, REFRESH_COOKIE_OPTS);
      return res.status(401).json({ success: false, error: 'Refresh token expired' });
    }

    const { user } = stored;
    if (user.deletedAt) {
      return res.status(401).json({ success: false, error: 'Account deleted' });
    }

    // Atomic rotation: revoke old + create new in one transaction
    const newRawToken = crypto.randomBytes(64).toString('hex');
    const expiresAt = new Date(Date.now() + REFRESH_TTL_MS);

    await prisma.$transaction([
      prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } }),
      prisma.refreshToken.create({ data: { token: newRawToken, userId: user.id, expiresAt } }),
    ]);

    res.cookie(REFRESH_COOKIE, newRawToken, { ...REFRESH_COOKIE_OPTS, maxAge: REFRESH_TTL_MS });

    const accessToken = jwt.sign(
      { userId: user.id, schoolId: user.schoolId ?? null, role: user.role, tokenVersion: user.tokenVersion },
      JWT_SECRET,
      { expiresIn: ACCESS_TOKEN_TTL }
    );

    res.json({ success: true, data: { token: accessToken } });
  } catch (error) {
    log.error({ err: error }, 'token refresh error');
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /auth/logout — revoke refresh token and clear cookie
router.post('/logout', requireTrustedOrigin, async (req: Request, res: Response) => {
  const rawToken = req.cookies?.[REFRESH_COOKIE] as string | undefined;
  if (rawToken) {
    await prisma.refreshToken.updateMany({
      where: { token: rawToken },
      data: { revokedAt: new Date() },
    }).catch(() => {}); // ignore if token not found
  }
  res.clearCookie(REFRESH_COOKIE, REFRESH_COOKIE_OPTS);
  res.json({ success: true });
});

// ==== Email Verification ====

router.get('/verify-email', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ success: false, error: 'Token is required' });
    }

    const user = await prisma.user.findFirst({
      where: {
        verificationToken: token,
        verificationExpires: { gt: new Date() }
      }
    });

    if (!user) {
      return res.status(400).json({ success: false, error: 'Invalid or expired token' });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerified: true,
        verificationToken: null,
        verificationExpires: null
      }
    });

    res.json({ success: true, message: 'Email успешно подтвержден' });
  } catch (error) {
    log.error({ err: error }, 'verify email error');
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

router.post('/resend-verification', resendVerificationLimiter, async (req, res) => {
  try {
    let { email } = req.body;
    if (email) email = email.toLowerCase().trim();
    if (!email) {
      return res.status(400).json({ success: false, error: 'Email is required' });
    }

    const user = await prisma.user.findFirst({ where: { email, deletedAt: null } });

    if (!user) {
      // Return success anyway to avoid email enumeration
      return res.json({ success: true, message: 'Если email существует, письмо отправлено' });
    }

    if (user.emailVerified) {
      return res.status(400).json({ success: false, error: 'Email уже подтвержден' });
    }

    const verificationToken = crypto.randomBytes(32).toString('hex');
    const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        verificationToken,
        verificationExpires
      }
    });

    const emailResult = await sendVerificationEmail(user.email!, verificationToken);

    res.json({
      success: true,
      message: 'Письмо отправлено',
      data: {
        devVerifyLink: process.env.NODE_ENV === 'development' ? (emailResult.data as any)?.verifyLink : undefined
      }
    });
  } catch (error) {
    log.error({ err: error }, 'resend verification error');
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ==== Forgot Password ====

const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  message: { success: false, error: 'Слишком много попыток. Попробуйте через час.' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.post('/forgot-password', forgotPasswordLimiter, async (req, res) => {
  try {
    let { email } = req.body;
    if (email) email = email.toLowerCase().trim();
    if (!email) {
      return res.status(400).json({ success: false, error: 'Email is required' });
    }

    const user = await prisma.user.findFirst({ where: { email, deletedAt: null } });
    if (!user) {
      return res.json({ success: true, message: 'Если email существует, инструкция отправлена' });
    }

    const randomHex = crypto.randomBytes(32).toString('hex');
    const token = `${user.id}.${randomHex}`;
    const tokenHash = await bcrypt.hash(randomHex, 10);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await prisma.resetToken.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt
      }
    });

    await sendPasswordResetEmail(user.email!, token);

    res.json({ success: true, message: 'Если email существует, инструкция отправлена' });
  } catch (error) {
    log.error({ err: error }, 'forgot password error');
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

router.get('/reset-password/validate', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ success: false, error: 'Token is required' });
    }

    const parts = token.split('.');
    if (parts.length !== 2) {
      return res.status(400).json({ success: false, error: 'Invalid token format' });
    }
    const [userIdStr, randomHex] = parts;
    const userId = parseInt(userIdStr, 10);

    const resetTokens = await prisma.resetToken.findMany({
      where: {
        userId,
        used: false,
        expiresAt: { gt: new Date() }
      }
    });

    let validTokenId = null;
    let userRecord = null;

    for (const rt of resetTokens) {
      const isMatch = await bcrypt.compare(randomHex, rt.tokenHash);
      if (isMatch) {
        validTokenId = rt.id;
        userRecord = await prisma.user.findUnique({ where: { id: userId } });
        break;
      }
    }

    if (!validTokenId || !userRecord) {
      return res.status(400).json({ success: false, error: 'Invalid or expired token' });
    }

    res.json({ success: true, valid: true, email: userRecord.email });
  } catch (error) {
    log.error({ err: error }, 'reset password validate error');
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

router.post('/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) {
      return res.status(400).json({ success: false, error: 'Token and newPassword are required' });
    }
    const passwordError = getPasswordError(newPassword);
    if (passwordError) {
      return res.status(400).json({ success: false, error: passwordError });
    }

    const parts = token.split('.');
    if (parts.length !== 2) {
      return res.status(400).json({ success: false, error: 'Invalid token format' });
    }
    const [userIdStr, randomHex] = parts;
    const userId = parseInt(userIdStr, 10);

    const resetTokens = await prisma.resetToken.findMany({
      where: {
        userId,
        used: false,
        expiresAt: { gt: new Date() }
      }
    });

    let validTokenId = null;
    let userRecord = null;

    for (const rt of resetTokens) {
      const isMatch = await bcrypt.compare(randomHex, rt.tokenHash);
      if (isMatch) {
        validTokenId = rt.id;
        userRecord = await prisma.user.findUnique({ where: { id: userId } });
        break;
      }
    }

    if (!validTokenId || !userRecord) {
      return res.status(400).json({ success: false, error: 'Invalid or expired token' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: { password: hashedPassword, tokenVersion: { increment: 1 } },
      }),
      prisma.resetToken.update({
        where: { id: validTokenId },
        data: { used: true },
      }),
    ]);

    // Invalidate user cache so the freshness check picks up the new tokenVersion immediately
    await invalidateUserCache(userId);

    res.json({ success: true, message: 'Пароль успешно изменен' });
  } catch (error) {
    log.error({ err: error }, 'reset password error');
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

export default router;
