import { Router } from 'express';
import { authenticate, AuthRequest } from '../middleware/authenticate';
import prisma from '../lib/prisma';
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import * as OTPAuth from 'otpauth';
import qrcode from 'qrcode';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import rateLimit from 'express-rate-limit';
import { invalidateUserCache } from '../lib/userCache';
import { getJwtSecret, ACCESS_TOKEN_TTL } from '../lib/jwtSecret';
import { createLogger } from '../lib/logger';
import { sendLifecycleError } from '../lib/routeError';

const log = createLogger('twoFa');
const router = Router();
const JWT_SECRET = getJwtSecret();

const rpName = 'Shamdan';
const rpID = process.env.RP_ID || 'localhost';
const origin = process.env.CLIENT_URL || 'http://localhost:5173';

// Rate Limiter for general 2FA operations (10 reqs / 5 min)
const twoFaLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  message: { success: false, error: 'Слишком много попыток. Попробуйте позже.' },
});

// Strict Rate Limiter specifically for disabling 2FA (5 reqs / 15 min per IP)
const disableTwoFaLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  message: { success: false, error: 'Слишком много попыток отключения 2FA. Попробуйте через 15 минут.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Middleware to parse tempToken
const authenticateTemp = (req: AuthRequest, res: any, next: any) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'No token provided' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    if (!decoded.isTemp2FA) {
      return res.status(401).json({ success: false, error: 'Invalid temp token' });
    }
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, error: 'Token is invalid or expired' });
  }
};

// -- HELPER to Generate Backup Codes --
const generateBackupCodes = () => {
  const codes = [];
  const hashedCodes = [];
  for (let i = 0; i < 10; i++) {
    const code = crypto.randomBytes(4).toString('hex').toLowerCase(); // 8 characters
    codes.push(code);
    const hash = crypto.createHash('sha256').update(code).digest('hex');
    hashedCodes.push(hash);
  }
  return { codes, hashedCodes };
};

// In-memory challenge store (use Redis in production)
// Positive keys = login/setup flow, negative keys (-userId) = disable flow
const challengeStore = new Map<number, string>();

// ==========================================
// DISABLE 2FA  (Secure — requires password + 2FA proof)
// ==========================================

// GET /api/2fa/disable/passkey/generate
// Generates a WebAuthn authentication challenge for the disable flow.
router.get('/disable/passkey/generate', authenticate, async (req: AuthRequest, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      include: { passkeys: true }
    });
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });
    if (!user.twoFactorEnabled) return res.status(400).json({ success: false, error: '2FA не включена' });
    if (!user.passkeys.length) return res.status(400).json({ success: false, error: 'Passkey не настроен' });

    const allowCredentials = user.passkeys.map(pk => ({
      id: pk.id,
      type: 'public-key' as const,
      transports: pk.transports ? pk.transports.split(',') as any : undefined,
    }));

    const options = await generateAuthenticationOptions({
      rpID,
      allowCredentials,
      userVerification: 'required', // require UV for disable — stronger than 'preferred'
    });

    // Store challenge under a namespaced key to avoid conflicts with login challenges
    challengeStore.set(-user.id, options.challenge); // negative key = disable flow
    res.json({ success: true, data: options });
  } catch (error: any) {
    log.error({ err: error }, 'disable passkey challenge generation error');
    sendLifecycleError(res, error, 'Не удалось создать запрос на подтверждение Passkey');
  }
});

// POST /api/2fa/disable
// Requires: { password, passkeyResponse? } OR { password, totpCode? }
// Both password AND one 2FA proof are required.
router.post('/disable', disableTwoFaLimiter, authenticate, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const { password, passkeyResponse, totpCode } = req.body;

    // ── 1. Validate request has required fields ──
    if (!password) {
      return res.status(400).json({ success: false, error: 'Пароль обязателен' });
    }
    if (!passkeyResponse && !totpCode) {
      return res.status(400).json({ success: false, error: 'Необходимо подтверждение через Passkey или TOTP' });
    }

    // ── 2. Fetch user with passkeys ──
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { passkeys: true },
      omit: { password: false, totpSecret: false }, // verified below
    });
    if (!user) return res.status(404).json({ success: false, error: 'Пользователь не найден' });
    if (!user.twoFactorEnabled) {
      return res.status(400).json({ success: false, error: '2FA уже отключена' });
    }

    // ── 3. Verify password ──
    const passwordMatch = await bcrypt.compare(password, user.password);
    if (!passwordMatch) {
      return res.status(403).json({ success: false, error: 'Неверный пароль' });
    }

    // ── 4. Verify 2FA factor ──
    if (passkeyResponse) {
      // --- Passkey path ---
      const expectedChallenge = challengeStore.get(-userId);
      if (!expectedChallenge) {
        return res.status(400).json({ success: false, error: 'Challenge истёк, начните заново' });
      }

      const passkey = user.passkeys.find(pk => pk.id === passkeyResponse.id);
      if (!passkey) {
        return res.status(404).json({ success: false, error: 'Passkey не найден для этого пользователя' });
      }

      let verification;
      try {
        verification = await verifyAuthenticationResponse({
          response: passkeyResponse,
          expectedChallenge,
          expectedOrigin: origin,
          expectedRPID: rpID,
          credential: {
            id: passkey.id,
            publicKey: new Uint8Array(passkey.publicKey),
            counter: Number(passkey.counter),
            transports: passkey.transports ? passkey.transports.split(',') as any : undefined,
          }
        });
      } catch (err: any) {
        log.error({ err }, 'passkey verify error during disable');
        return res.status(400).json({ success: false, error: 'Ошибка верификации Passkey: ' + err.message });
      }

      if (!verification.verified) {
        return res.status(403).json({ success: false, error: 'Passkey не прошёл верификацию' });
      }

      challengeStore.delete(-userId);

    } else if (totpCode) {
      // --- TOTP path ---
      if (!user.totpSecret) {
        return res.status(400).json({ success: false, error: 'TOTP не настроен' });
      }

      const totp = new OTPAuth.TOTP({
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(user.totpSecret)
      });

      const isValid = totp.validate({ token: String(totpCode).trim(), window: 1 }) !== null;
      if (!isValid) {
        return res.status(403).json({ success: false, error: 'Неверный TOTP-код' });
      }
    }

    // ── 5. Atomically wipe all 2FA data ──
    log.warn({ userId }, '2FA disabled by user');
    await prisma.$transaction([
      prisma.userPasskey.deleteMany({ where: { userId } }),
      prisma.user.update({
        where: { id: userId },
        data: {
          twoFactorEnabled: false,
          totpSecret: null,
          backupCodes: [],
        }
      })
    ]);

    return res.json({ success: true, message: 'Двухфакторная аутентификация успешно отключена' });
  } catch (error: any) {
    log.error({ err: error }, 'disable 2FA error');
    sendLifecycleError(res, error, 'Не удалось отключить двухфакторную аутентификацию');
  }
});

// ==========================================
// SETUP ENDPOINTS (Requires standard token)
// ==========================================

// 1. Passkey: Generate Registration Options
router.get('/setup/passkey/generate-options', authenticate, async (req: AuthRequest, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user!.userId }, include: { passkeys: true } });
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    const userPasskeys = user.passkeys.map(pk => ({
      id: pk.id, // we store as base64url string
      type: 'public-key' as const,
      transports: pk.transports ? pk.transports.split(',') as any : undefined,
    }));

    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userID: new Uint8Array(Buffer.from(user.id.toString())),
      userName: user.email ?? `user-${user.id}`,
      attestationType: 'none',
      excludeCredentials: userPasskeys,
      authenticatorSelection: {
         residentKey: 'required',
         userVerification: 'preferred',
      }
    });

    // Store challenge in memory or session. For stateless, you can use DB or quick caching.
    // For simplicity, we'll store it on user record as a temporary field, or use json schema.
    // Since we don't have a challenge field in DB, we'll store it as part of settings or quick cache.
    // However, the best way for stateless is to sign the challenge to the client so the client returns it.
    // To be perfectly spec-compliant, SimpleWebauthn requires the server to remember the challenge.
    
    res.json({ success: true, data: options });
  } catch (error: any) {
    log.error({ err: error }, 'passkey registration options error');
    sendLifecycleError(res, error, 'Could not generate passkey registration options');
  }
});

// Since we are stateless, challenges are stored in the challengeStore Map above.
// See its declaration at the top of this file.

router.get('/setup/passkey/generate', authenticate, async (req: AuthRequest, res) => {
    try {
      const user = await prisma.user.findUnique({ where: { id: req.user!.userId }, include: { passkeys: true } });
      if (!user) return res.status(404).json({ success: false, error: 'User not found' });
  
      const userPasskeys = user.passkeys.map(pk => ({
        id: pk.id,
        type: 'public-key' as const,
        transports: pk.transports ? pk.transports.split(',') as any : undefined,
      }));
  
      const options = await generateRegistrationOptions({
        rpName,
        rpID,
        userID: new Uint8Array(Buffer.from(user.id.toString())),
        userName: user.email ?? `user-${user.id}`,
        attestationType: 'none',
        excludeCredentials: userPasskeys,
        authenticatorSelection: {
           residentKey: 'required',
           userVerification: 'preferred',
        }
      });
  
      challengeStore.set(user.id, options.challenge);
      res.json({ success: true, data: options });
    } catch (error: any) {
      log.error({ err: error }, 'passkey registration challenge generation error');
      sendLifecycleError(res, error, 'Could not generate passkey registration challenge');
    }
  });

// 2. Passkey: Verify Registration
router.post('/setup/passkey/verify', authenticate, async (req: AuthRequest, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user!.userId }, omit: { backupCodes: false } });
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    const expectedChallenge = challengeStore.get(user.id);
    if (!expectedChallenge) return res.status(400).json({ success: false, error: 'Challenge expired or not found' });

    const body = req.body;
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: body,
        expectedChallenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
      });
    } catch (error: any) {
      log.error({ err: error }, 'passkey registration verification error');
      return res.status(400).json({ success: false, error: error.message });
    }

    if (verification.verified && verification.registrationInfo) {
      const { credentialDeviceType, credentialBackedUp, credential } = verification.registrationInfo;

      // Output id from credential.id
      const idStr = credential.id;

      await prisma.userPasskey.create({
        data: {
          id: idStr,
          userId: user.id,
          publicKey: Buffer.from(credential.publicKey),
          counter: BigInt(credential.counter),
          deviceType: credentialDeviceType,
          backedUp: credentialBackedUp,
          transports: credential.transports ? credential.transports.join(',') : undefined,
        }
      });

      // Turn on 2FA automatically if it wasn't
      const isFirstSetup = !user.twoFactorEnabled;
      const { codes, hashedCodes } = generateBackupCodes();
      
      await prisma.user.update({
         where: { id: user.id },
         data: {
             twoFactorEnabled: true,
             backupCodes: isFirstSetup ? hashedCodes : user.backupCodes // override only if first time
         }
      });

      challengeStore.delete(user.id);
      return res.json({ success: true, data: { verified: true, backupCodes: isFirstSetup ? codes : null } });
    } else {
        return res.status(400).json({ success: false, error: 'Verification failed' });
    }
  } catch (error: any) {
    log.error({ err: error }, 'passkey setup verify error');
    sendLifecycleError(res, error, 'Could not verify passkey registration');
  }
});

// 3. TOTP: Generate
router.get('/setup/totp/generate', authenticate, async (req: AuthRequest, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user!.userId } });
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    const secret = new OTPAuth.Secret({ size: 20 });
    const totp = new OTPAuth.TOTP({
      issuer: rpName,
      label: user.email ?? `user-${user.id}`,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: secret
    });
    
    const otpauthUrl = totp.toString();
    const qrDataUrl = await qrcode.toDataURL(otpauthUrl);

    // Save temporal secret in challenge store
    challengeStore.set(user.id, secret.base32);

    res.json({ success: true, data: { qrDataUrl, secret: secret.base32 } });
  } catch (err: any) {
    log.error({ err }, 'TOTP generate error');
    sendLifecycleError(res, err, 'Could not generate TOTP');
  }
});

// 4. TOTP: Verify Setup
router.post('/setup/totp/verify', authenticate, async (req: AuthRequest, res) => {
  try {
     const user = await prisma.user.findUnique({ where: { id: req.user!.userId }, omit: { backupCodes: false } });
     if (!user) return res.status(404).json({ success: false, error: 'User not found' });

     const { code } = req.body;
     const secret = challengeStore.get(user.id);
     if (!secret) return res.status(400).json({ success: false, error: 'No TOTP setup in progress' });

     const totp = new OTPAuth.TOTP({
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(secret)
     });
     
     const isValid = totp.validate({ token: code, window: 1 }) !== null;
     if (!isValid) return res.status(400).json({ success: false, error: 'Invalid TOTP code' });

     const isFirstSetup = !user.twoFactorEnabled;
     const { codes, hashedCodes } = generateBackupCodes();

     await prisma.user.update({
        where: { id: user.id },
        data: {
          totpSecret: secret,
          twoFactorEnabled: true,
          backupCodes: isFirstSetup ? hashedCodes : user.backupCodes
        }
     });

     challengeStore.delete(user.id);
     return res.json({ success: true, data: { verified: true, backupCodes: isFirstSetup ? codes : null } });
  } catch(err: any) {
     log.error({ err }, 'TOTP setup verify error');
     sendLifecycleError(res, err, 'Could not verify TOTP setup');
  }
});

// ==========================================
// LOGIN ENDPOINTS (Requires temp token)
// ==========================================

// Helper to fully authenticate user after 2FA bypass
const completeLogin = async (userId: number, res: any) => {
  const user = await prisma.user.findUnique({ where: { id: userId }, include: { school: true } });
  if (!user) return res.status(404).json({ success: false, error: 'User not found' });

  const token = jwt.sign(
      { userId: user.id, schoolId: user.schoolId ?? null, role: user.role, tokenVersion: user.tokenVersion },
      JWT_SECRET,
      { expiresIn: ACCESS_TOKEN_TTL }
  );

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
          city: user.school.city
        } : null
      }
  });
};

router.get('/login/passkey/generate', authenticateTemp, async (req: AuthRequest, res) => {
   try {
     const user = await prisma.user.findUnique({ where: { id: req.user!.userId }, include: { passkeys: true }});
     if (!user) return res.status(404).json({ success: false, error: 'User not found' });

     const allowCredentials = user.passkeys.map(pk => ({
         id: pk.id,
         type: 'public-key' as const,
         transports: pk.transports ? pk.transports.split(',') as any : undefined,
     }));

     const options = await generateAuthenticationOptions({
         rpID,
         allowCredentials,
         userVerification: 'preferred',
     });

     challengeStore.set(user.id, options.challenge);
     res.json({ success: true, data: options });
   } catch(error: any) {
       log.error({ err: error }, 'login passkey challenge generation error');
       sendLifecycleError(res, error, 'Could not generate passkey login challenge');
   }
});

router.post('/login/passkey/verify', twoFaLimiter, authenticateTemp, async (req: AuthRequest, res) => {
  try {
     const user = await prisma.user.findUnique({ where: { id: req.user!.userId }, include: { passkeys: true }});
     if (!user) return res.status(404).json({ success: false, error: 'User not found' });

     const expectedChallenge = challengeStore.get(user.id);
     if (!expectedChallenge) return res.status(400).json({ success: false, error: 'Challenge expired' });

     const body = req.body;
     const passkey = user.passkeys.find(pk => pk.id === body.id);
     if (!passkey) return res.status(404).json({ success: false, error: 'Passkey not found for this user' });

     let verification;
     try {
       verification = await verifyAuthenticationResponse({
         response: body,
         expectedChallenge,
         expectedOrigin: origin,
         expectedRPID: rpID,
         credential: {
            id: passkey.id,
            publicKey: new Uint8Array(passkey.publicKey),
            counter: Number(passkey.counter),
            transports: passkey.transports ? passkey.transports.split(',') as any : undefined,
         }
       });
     } catch (err: any) {
         log.error({ err }, 'login passkey verification error');
         return res.status(400).json({ success: false, error: err.message });
     }

     if (verification.verified) {
         await prisma.userPasskey.update({
             where: { id: passkey.id },
             data: {
                 counter: BigInt(verification.authenticationInfo.newCounter),
                 lastUsedAt: new Date()
             }
         });
         challengeStore.delete(user.id);
         return completeLogin(user.id, res);
     } else {
         return res.status(400).json({ success: false, error: 'Passkey verification failed' });
     }
  } catch (err: any) {
      log.error({ err }, 'login passkey verify error');
      sendLifecycleError(res, err, 'Could not verify passkey login');
  }
});

// TOTP Verification for Login
router.post('/login/totp/verify', twoFaLimiter, authenticateTemp, async (req: AuthRequest, res) => {
   try {
       const user = await prisma.user.findUnique({ where: { id: req.user!.userId }, omit: { totpSecret: false } });
       if (!user) return res.status(404).json({ success: false, error: 'User not found' });
       if (!user.totpSecret) return res.status(400).json({ success: false, error: 'TOTP not configured' });

       const { code } = req.body;
       const totp = new OTPAuth.TOTP({
          algorithm: 'SHA1',
          digits: 6,
          period: 30,
          secret: OTPAuth.Secret.fromBase32(user.totpSecret)
       });
       
       const isValid = totp.validate({ token: code, window: 1 }) !== null;

       if (!isValid) {
           return res.status(400).json({ success: false, error: 'Invalid TOTP code' });
       }

       return completeLogin(user.id, res);
   } catch(err: any) {
       log.error({ err }, 'login TOTP verify error');
       sendLifecycleError(res, err, 'Could not verify TOTP code');
   }
});

// Backup Code Verification for Login
router.post('/login/backup/verify', twoFaLimiter, authenticateTemp, async (req: AuthRequest, res) => {
    try {
        const user = await prisma.user.findUnique({ where: { id: req.user!.userId }, omit: { backupCodes: false } });
        if (!user) return res.status(404).json({ success: false, error: 'User not found' });

        const { code } = req.body;
        const hash = crypto.createHash('sha256').update(code.toLowerCase().trim()).digest('hex');

        if (user.backupCodes.includes(hash)) {
            // Remove used backup code
            const newBackupCodes = user.backupCodes.filter(hc => hc !== hash);
            await prisma.user.update({
                where: { id: user.id },
                data: { backupCodes: newBackupCodes }
            });

            return completeLogin(user.id, res);
        }

        return res.status(400).json({ success: false, error: 'Invalid backup code' });
    } catch(err: any) {
        log.error({ err }, 'login backup code verify error');
        sendLifecycleError(res, err, 'Could not verify backup code');
    }
});

export default router;
