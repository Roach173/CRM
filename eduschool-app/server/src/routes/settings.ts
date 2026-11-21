import { Router } from 'express';
import { Prisma, Role, BillingMode } from '@prisma/client';
import prisma from '../lib/prisma';
import { recomputePaidUntilForSchool } from '../lib/paidUntilDerivation';
import { authenticate, AuthRequest } from '../middleware/authenticate';
import { requirePermission } from '../middleware/requirePermission';
import { getPolicyForDate, computePolicyImpact, getFirstWorkingDateStr, generatePolicySlotDefs, makeCachedPolicyResolver, type PolicySnapshot } from '../services/policyService';
import { dateInTz, getNextMondayDateInTz, getWeekBoundaries, getTodayDateInTz } from '../lib/tzUtils';
import { createLogger } from '../lib/logger';
import { logSecurityEvent } from '../lib/auditLog';
import {
  AttributionSettingsError,
  readAttributionSettings,
  sanitizeAttributionSettingsInput,
} from '../lib/leadAttribution';
import { isTenantNotFound, isPrismaNotFound, assertWebhookBelongsToSchool, assertIntegrationBelongsToSchool } from '../lib/tenant';
import { parsePauseInt } from '../services/freezeService';
import {
  PixelSettingsError,
  readPixelSettings,
  sanitizePixelSettingsInput,
} from '../lib/pixels';
import { readHelpTopics } from '../lib/helpTopics';
import { sanitizeWebhookEvents, WebhookEventError } from '../lib/webhookEvents';
import {
  generateWebhookSecret,
  maskWebhookSecret,
  validateWebhookUrl,
  WebhookUrlError,
} from '../lib/webhookSecurity';
import { deliverWebhookForTest } from '../lib/webhooks';
import { emitToSchool } from '../lib/socket';
import {
  getDefaultCredentialStatus,
  getDefaultIntegrationStatus,
  getIntegrationProvider,
  getManualConnectionStatus,
  hasCredentialFields,
  INTEGRATION_PROVIDERS,
  INTEGRATION_STATUS,
  IntegrationLogStatus,
  IntegrationProvider,
  IntegrationStatus,
  isIntegrationProvider,
  isIntegrationStatus,
  listIntegrationProviders,
  sanitizeIntegrationConnection,
  sanitizeIntegrationDisplayName,
  sanitizeIntegrationMessage,
} from '../lib/integrations';

const log = createLogger('settings');
const router = Router();

export function canClearAllData(
  env = process.env.NODE_ENV,
  allowFlag = process.env.ALLOW_CLEAR_ALL_DATA,
): boolean {
  if (env === 'production' && allowFlag !== 'true') return false;
  return true;
}

const WEBHOOK_SELECT = {
  id: true,
  url: true,
  events: true,
  secret: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  lastDeliveryAt: true,
  lastStatus: true,
  failureCount: true,
  secretRotatedAt: true,
} satisfies Prisma.WebhookSelect;

const INTEGRATION_CONNECTION_SELECT = {
  id: true,
  provider: true,
  category: true,
  status: true,
  enabled: true,
  displayName: true,
  credentialStatus: true,
  scopes: true,
  lastSyncAt: true,
  lastError: true,
  connectedAt: true,
  disconnectedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.IntegrationConnectionSelect;

function parseNumericId(value: string): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function serializeWebhook<T extends { secret: string }>(webhook: T) {
  return { ...webhook, secret: maskWebhookSecret(webhook.secret) };
}

function serializeIntegrationCard(
  connection: Prisma.IntegrationConnectionGetPayload<{ select: typeof INTEGRATION_CONNECTION_SELECT }> | undefined,
  provider: IntegrationProvider,
) {
  return {
    provider: provider.key,
    displayName: connection?.displayName || provider.displayName,
    providerDisplayName: provider.displayName,
    category: provider.category,
    status: connection?.status ?? getDefaultIntegrationStatus(),
    enabled: connection?.enabled ?? false,
    credentialStatus: connection?.credentialStatus ?? null,
    scopes: connection?.scopes ?? [],
    lastSyncAt: connection?.lastSyncAt ?? null,
    lastError: connection?.lastError ?? null,
    connectedAt: connection?.connectedAt ?? null,
    disconnectedAt: connection?.disconnectedAt ?? null,
    connectionId: connection?.id ?? null,
  };
}

async function recordIntegrationEvent(tx: Prisma.TransactionClient, input: {
  schoolId: number;
  connectionId: number;
  provider: string;
  eventType: string;
  status: IntegrationLogStatus;
  message?: string;
  occurredAt?: Date;
}) {
  return tx.integrationSyncLog.create({
    data: {
      schoolId: input.schoolId,
      connectionId: input.connectionId,
      provider: input.provider,
      eventType: input.eventType,
      status: input.status,
      message: sanitizeIntegrationMessage(input.message),
      occurredAt: input.occurredAt ?? new Date(),
    },
  });
}

function getIntegrationUpdateStatus(input: {
  enabled?: boolean;
  requestedStatus?: IntegrationStatus;
  previousStatus: string;
  provider: IntegrationProvider;
}): IntegrationStatus | undefined {
  if (input.requestedStatus) return input.requestedStatus;
  if (input.enabled === false) return INTEGRATION_STATUS.disabled;
  if (
    input.enabled === true &&
    (input.previousStatus === INTEGRATION_STATUS.disabled || input.previousStatus === INTEGRATION_STATUS.disconnected)
  ) {
    return getManualConnectionStatus(input.provider);
  }
  return undefined;
}

// Regenerates TimeSlot rows for a school when schedule settings change.
// Migrates blocks and syncs session snaps, then deletes stale empty slots.
async function syncTimeSlots(schoolId: number, workStart: string, workEnd: string, slotDuration: number) {
  const defs = generatePolicySlotDefs({ workStart, workEnd, slotDuration, activeDays: [] } as PolicySnapshot);
  if (!defs.length) return;

  for (const def of defs) {
    const upserted = await prisma.timeSlot.upsert({
      where: { schoolId_startTime_endTime: { schoolId, startTime: def.startTime, endTime: def.endTime } },
      update: { order: def.order },
      create: { schoolId, startTime: def.startTime, endTime: def.endTime, order: def.order },
    });

    // 1. Update time cache on blocks already using this slot
    await prisma.lessonBlock.updateMany({
      where: { schoolId, timeSlotId: upserted.id },
      data: { startTime: def.startTime, endTime: def.endTime },
    });

    // 2. Migrate blocks from any OLD slot with same startTime but different endTime
    //    (handles slotDuration change: 08:00-09:40 → 08:00-09:20 etc.)
    const staleOverlapSlots = await prisma.timeSlot.findMany({
      where: { schoolId, startTime: def.startTime, endTime: { not: def.endTime } },
    });
    for (const oldSlot of staleOverlapSlots) {
      await prisma.lessonBlock.updateMany({
        where: { schoolId, timeSlotId: oldSlot.id },
        data: { timeSlotId: upserted.id, startTime: def.startTime, endTime: def.endTime },
      });
    }

    // 3. Sync startTimeSnap/endTimeSnap on upcoming sessions for ALL blocks now on this slot.
    //    Must run AFTER migrations so it captures both existing and migrated blocks.
    //    Skip sessions with manual time overrides and already-completed sessions.
    const affectedBlocks = await prisma.lessonBlock.findMany({
      where: { schoolId, timeSlotId: upserted.id },
      select: { id: true },
    });
    if (affectedBlocks.length > 0) {
      await prisma.lessonSession.updateMany({
        where: {
          schoolId,
          lessonBlockId: { in: affectedBlocks.map(b => b.id) },
          isManualTime: false,
          status: { not: 'COMPLETED' },
        },
        data: { startTimeSnap: def.startTime, endTimeSnap: def.endTime },
      });
    }
  }

  // Delete stale slots no longer in the new set and not referenced by any block
  const newKeys = new Set(defs.map(d => `${d.startTime}|${d.endTime}`));
  const allSlots = await prisma.timeSlot.findMany({
    where: { schoolId },
    include: { _count: { select: { blocks: true } } },
  });
  for (const slot of allSlots) {
    const key = `${slot.startTime}|${slot.endTime}`;
    if (!newKeys.has(key) && (slot as any)._count.blocks === 0) {
      await prisma.timeSlot.delete({ where: { id: slot.id } });
    }
  }

  // Rewrite order for ALL remaining rows so no two rows share the same order value.
  // Old slots that survived (still referenced by LessonBlock) keep stale order values
  // from a previous config, causing order collisions with new slots (both getting order=5,
  // for example). This produces unsorted grids like: 06:40, 13:00, 08:00...
  // Fix: sort remaining rows by startTime and rewrite order 0..N-1.
  const remaining = await prisma.timeSlot.findMany({
    where: { schoolId },
    orderBy: [{ startTime: 'asc' }, { endTime: 'asc' }],
    select: { id: true },
  });
  await Promise.all(
    remaining.map((sl, i) =>
      prisma.timeSlot.update({ where: { id: sl.id }, data: { order: i } }),
    ),
  );
}

// Индекс колонки сетки → русское сокращение (как хранится в LessonBlock.days)
const COL_TO_ABBR: Record<number, string> = {
  0: 'Пн', 1: 'Вт', 2: 'Ср', 3: 'Чт', 4: 'Пт', 5: 'Сб', 6: 'Вс',
};

// GET /api/settings — returns the full school config blob; gated to staff
// (settings:read = SUPERADMIN/OWNER/ADMIN). Students/teachers read narrow
// endpoints instead (GET /settings/timeslots, GET /settings/help).
router.get('/', authenticate, requirePermission('settings:read'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user?.schoolId;
    const school = await prisma.school.findFirst({
      where: { id: schoolId, deletedAt: null },
      select: { id: true, name: true, slug: true, email: true, city: true, phone: true, address: true, description: true, createdAt: true, settings: true, timezone: true }
    });

    if (!school) return res.status(404).json({ success: false, error: 'School not found' });

    // Editor shows the most-recently-configured policy (incl. a pending future-effective
    // one), not the one active today — otherwise a just-saved change that takes effect
    // next Monday looks like it didn't save. Falls back to today's policy / School columns
    // when no policy rows exist yet.
    const latestPolicy = await prisma.schoolSchedulePolicy.findFirst({
      where: { schoolId: school.id },
      orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      select: { activeDays: true, workStart: true, workEnd: true, slotDuration: true },
    });
    const policy = latestPolicy ?? await getPolicyForDate(school.id, new Date());
    // Schedule policy rows are authoritative; School columns are legacy/cache only.
    const jsonSettings = (school.settings as object) || {};
    const data = {
      ...jsonSettings,
      activeDays: policy.activeDays.length > 0 ? policy.activeDays : [0, 1, 2, 3, 4, 5],
      workStart: policy.workStart,
      workEnd: policy.workEnd,
      slotDuration: policy.slotDuration,
      timezone: school.timezone,
    };
    res.json({ success: true, data });
  } catch (error) {
    log.error({ err: error }, 'fetch settings error');
    res.status(500).json({ success: false, error: 'Failed to fetch settings' });
  }
});

// PATCH /api/settings — merge profile settings; schedule fields create/update a dated policy.
// OWNER/SUPERADMIN only: mutations here affect school profile and schedule policy.
router.patch('/', authenticate, requirePermission('settings:write'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId!;
    if (req.user!.role !== 'OWNER' && req.user!.role !== 'SUPERADMIN') {
      return res.status(403).json({ success: false, error: 'Forbidden: OWNER role required' });
    }
    const { activeDays, workStart, workEnd, slotDuration, timezone, ...rest } = req.body;

    const school = await prisma.school.findFirst({ where: { id: schoolId, deletedAt: null } });
    if (!school) return res.status(404).json({ success: false, error: 'School not found' });
    const currentPolicy = await getPolicyForDate(schoolId, new Date());
    const parseMin = (t: string) => { const [h, m] = t.split(':').map(Number); return (h || 0) * 60 + (m || 0); };

    if (typeof workStart === 'string' || typeof workEnd === 'string' || typeof slotDuration === 'number') {
      const ws = typeof workStart === 'string' ? workStart : currentPolicy.workStart;
      const we = typeof workEnd === 'string' ? workEnd : currentPolicy.workEnd;
      const dur = typeof slotDuration === 'number' ? slotDuration : currentPolicy.slotDuration;
      const wsMin = parseMin(ws);
      const weMin = parseMin(we);
      const durClamped = Math.max(30, Math.min(240, dur));
      if (wsMin < 300 || weMin > 1380) {
        return res.status(400).json({
          success: false,
          error: 'WORK_HOURS_OUT_OF_RANGE',
          message: 'Рабочее время должно быть в диапазоне 05:00–23:00.',
        });
      }
      if (wsMin >= weMin) {
        return res.status(400).json({
          success: false,
          error: 'WORK_HOURS_OUT_OF_RANGE',
          message: 'Время начала работы должно быть раньше времени окончания.',
        });
      }
      const slotCount = Math.floor((weMin - wsMin) / durClamped);
      if (slotCount > 32) {
        return res.status(400).json({
          success: false,
          error: 'WORK_HOURS_OUT_OF_RANGE',
          message: `Слишком много слотов (${slotCount}). Уменьшите диапазон времени или увеличьте длительность урока.`,
        });
      }
    }
    const current: any = school?.settings || {};
    // Exclude schedule time fields from JSON blob — they now live in proper columns
    const { workStart: _ws, workEnd: _we, slotDuration: _sd, ...restCurrent } = current;
    const merged = { ...restCurrent, ...rest };

    const newActiveDays = Array.isArray(activeDays)
      ? (activeDays as number[]).filter(d => d >= 0 && d <= 6).sort()
      : null;

    await prisma.school.update({
      where: { id: schoolId },
      data: {
        settings: merged,
        ...(typeof timezone === 'string' && { timezone }),
      },
    });

    // Write policy audit log + close previous version + open new temporal version.
    // effectiveFrom = next Monday in school timezone (policy takes effect at start of
    // next week — sessions this week are unaffected).
    const policyChanged = newActiveDays || typeof workStart === 'string' || typeof workEnd === 'string' || typeof slotDuration === 'number';

    let policyEffectiveFrom: string | null = null;
    let firstWorkingDate: string | null = null;
    let impact = await computePolicyImpact(
      schoolId,
      {
        activeDays: newActiveDays ?? (currentPolicy.activeDays.length > 0 ? currentPolicy.activeDays : [0,1,2,3,4,5]),
        workStart: typeof workStart === 'string' ? workStart : currentPolicy.workStart,
        workEnd: typeof workEnd === 'string' ? workEnd : currentPolicy.workEnd,
      },
    );

    if (policyChanged) {
      const tz = (school as any)?.timezone ?? 'UTC';
      // First-ever policy for this school → effective today so the grid is usable immediately.
      // Subsequent changes → effective next Monday (sessions this week are unaffected).
      const existingPolicyCount = await prisma.schoolSchedulePolicy.count({ where: { schoolId } });
      const isFirstPolicy = existingPolicyCount === 0;
      const { date: effectiveDate, dateStr: effectiveDateStr } = isFirstPolicy
        ? getTodayDateInTz(tz)
        : getNextMondayDateInTz(tz);
      let policyData: { activeDays: number[]; workStart: string; workEnd: string; slotDuration: number } | null = null;
      policyData = {
        activeDays: newActiveDays ?? currentPolicy.activeDays,
        workStart: typeof workStart === 'string' ? workStart : currentPolicy.workStart,
        workEnd: typeof workEnd === 'string' ? workEnd : currentPolicy.workEnd,
        slotDuration: typeof slotDuration === 'number' ? Math.max(30, Math.min(240, slotDuration)) : currentPolicy.slotDuration,
      };
      impact = await computePolicyImpact(
        schoolId,
        { activeDays: policyData.activeDays, workStart: policyData.workStart, workEnd: policyData.workEnd },
        effectiveDate,
      );

      await prisma.$transaction(async (tx) => {
        await tx.schoolPolicyLog.create({
          data: { schoolId, ...policyData, changedById: req.user!.userId },
        });
        // Close previous open policy at effectiveDate — old policy stays valid until then
        await tx.schoolSchedulePolicy.updateMany({
          where: {
            schoolId,
            effectiveFrom: { lt: effectiveDate },
            OR: [{ effectiveTo: null }, { effectiveTo: { gt: effectiveDate } }],
          },
          data: { effectiveTo: effectiveDate },
        });
        const existingSameEffectiveFrom = await tx.schoolSchedulePolicy.findFirst({
          where: { schoolId, effectiveFrom: effectiveDate },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: { id: true },
        });
        if (existingSameEffectiveFrom) {
          await tx.schoolSchedulePolicy.update({
            where: { id: existingSameEffectiveFrom.id },
            data: { ...policyData, effectiveTo: null, createdById: req.user!.userId },
          });
        } else {
          await tx.schoolSchedulePolicy.create({
            data: { schoolId, ...policyData, effectiveFrom: effectiveDate, createdById: req.user!.userId },
          });
        }
      });

      policyEffectiveFrom = effectiveDate.toISOString();
      firstWorkingDate = getFirstWorkingDateStr(effectiveDateStr, (policyData as any)?.activeDays ?? [0,1,2,3,4]);

      log.info(
        { event: 'POLICY_CHANGED', schoolId, changedById: req.user!.userId,
          newPolicy: policyData, effectiveFrom: policyEffectiveFrom, firstWorkingDate, isFirstPolicy },
        `School schedule policy updated — effective ${isFirstPolicy ? 'immediately (bootstrap)' : 'next Monday'}`
      );

      emitToSchool(schoolId, 'schedule:structure-changed', { action: 'policy-changed' });
    }

    // Settings are generator rules only — no automatic session mutation on change.
    // Calculate impact for informational display; director resolves conflicts manually.
    res.json({
      success: true,
      data: {
        policyEffectiveFrom,
        firstWorkingDate,
        policyImpact: {
          sessionsOutsideDays: impact.sessionsOutsideDays,
          sessionsOutsideHours: impact.sessionsOutsideHours,
          blocksOutsideDays: impact.blocksOutsideDays,
          blocksOutsideHours: impact.blocksOutsideHours,
          affectedBlockIds: impact.affectedBlockIds,
        },
      },
    });
  } catch (error) {
    log.error({ err: error }, 'update settings error');
    res.status(500).json({ success: false, error: 'Failed to update settings' });
  }
});

// POST /api/settings/sync-timeslots — legacy manual repair for DB TimeSlot rows.
router.post('/sync-timeslots', authenticate, requirePermission('settings:write'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId!;
    const school = await prisma.school.findFirst({
      where: { id: schoolId, deletedAt: null },
      select: { id: true },
    });
    if (!school) {
      return res.status(400).json({ success: false, error: 'Настройки расписания не заданы' });
    }
    const policy = await getPolicyForDate(schoolId, new Date());
    await syncTimeSlots(schoolId, policy.workStart, policy.workEnd, policy.slotDuration);
    emitToSchool(schoolId, 'schedule:structure-changed', { action: 'timeslots-synced' });
    res.json({ success: true });
  } catch (error) {
    log.error({ err: error }, 'sync timeslots error');
    res.status(500).json({ success: false, error: 'Ошибка синхронизации слотов' });
  }
});

// POST /api/settings/repair-invalidated — dry-run and restore sessions incorrectly
// marked INVALIDATED by a past activeDays change (before the no-mutation policy).
// Default: dry-run (?apply=false). Pass ?apply=true to commit the restore.
//
// Eligibility criteria (ALL must be true):
//   - status = INVALIDATED
//   - date > now (future only)
//   - no Attendance records
//   - no LessonCreditLog with amount < 0
//   - no TeacherPaymentLesson links
//   - policy active on the session date includes the session day
//   - block.days includes the session day
//   - block not deleted
router.post('/repair-invalidated', authenticate, requirePermission('users:manage'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId!;
    const apply = req.query.apply === 'true';

    const school = await prisma.school.findFirst({
      where: { id: schoolId, deletedAt: null },
      select: { id: true },
    });
    if (!school) return res.status(404).json({ success: false, error: 'School not found' });

    const candidates = await prisma.lessonSession.findMany({
      where: { schoolId, deletedAt: null, status: 'INVALIDATED', date: { gte: new Date() } },
      select: {
        id: true,
        date: true,
        lessonBlock: { select: { id: true, days: true, deletedAt: true } },
      },
    });

    if (candidates.length === 0) {
      return res.json({ success: true, data: { eligible: 0, restored: 0, apply } });
    }

    const candidateIds = candidates.map(c => c.id);
    const [attendances, creditLogs, paymentLinks] = await Promise.all([
      prisma.attendance.findMany({
        where: { lessonSessionId: { in: candidateIds } },
        select: { lessonSessionId: true },
      }),
      prisma.lessonCreditLog.findMany({
        where: { sessionId: { in: candidateIds }, amount: { lt: 0 } },
        select: { sessionId: true },
      }),
      prisma.teacherPaymentLesson.findMany({
        where: { lessonSessionId: { in: candidateIds } },
        select: { lessonSessionId: true },
      }),
    ]);

    const financialIds = new Set([
      ...attendances.map(a => a.lessonSessionId),
      ...creditLogs.map(c => c.sessionId).filter((id): id is number => id !== null),
      ...paymentLinks.map(p => p.lessonSessionId),
    ]);

    const eligible: typeof candidates = [];
    const policyForDate = makeCachedPolicyResolver(schoolId);
    for (const s of candidates) {
      if (financialIds.has(s.id)) continue;
      if (!s.lessonBlock || s.lessonBlock.deletedAt) continue;
      const policy = await policyForDate(s.date);
      const activeSet = new Set((policy.activeDays ?? []).length > 0 ? policy.activeDays : [0, 1, 2, 3, 4]);
      const dayIdx = (new Date(s.date).getUTCDay() + 6) % 7;
      if (!activeSet.has(dayIdx)) continue;
      if (!s.lessonBlock.days.includes(dayIdx)) continue;
      eligible.push(s);
    }

    let restored = 0;
    if (apply && eligible.length > 0) {
      const updated = await prisma.lessonSession.updateMany({
        where: { id: { in: eligible.map(s => s.id) } },
        data: { status: 'UPCOMING', version: { increment: 1 } },
      });
      restored = updated.count;
      log.info(
        { event: 'SESSIONS_RESTORED', schoolId, restored, sessionIds: eligible.map(s => s.id) },
        'INVALIDATED sessions restored to UPCOMING via repair endpoint'
      );
    }

    res.json({
      success: true,
      data: { eligible: eligible.length, restored, apply, sessionIds: eligible.map(s => s.id) },
    });
  } catch (error) {
    log.error({ err: error }, 'repair invalidated sessions error');
    res.status(500).json({ success: false, error: 'Failed to run repair' });
  }
});

// GET /api/settings/timeslots — time slots + active days for the school.
// Accepts optional ?date=YYYY-MM-DD — returns policy that was active on that date
// for historically-correct rendering of past schedule weeks.
router.get('/timeslots', authenticate, async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user?.schoolId!;
    const dateParam = typeof req.query.date === 'string' ? req.query.date : null;
    const queryDate = dateParam ? new Date(`${dateParam}T12:00:00.000Z`) : new Date();

    const [policy, dbSlots, schoolForPolicy] = await Promise.all([
      getPolicyForDate(schoolId, queryDate),
      prisma.timeSlot.findMany({
        where: { schoolId },
        select: { id: true, startTime: true, endTime: true },
      }),
      prisma.school.findFirst({
        where: { id: schoolId, deletedAt: null },
        select: { timezone: true },
      }),
    ]);

    const dbIdByTime = new Map(dbSlots.map(s => [`${s.startTime}|${s.endTime}`, s.id]));
    const byTime = new Map<string, { id: number; startTime: string; endTime: string; order: number }>();
    const addSlot = (startTime: string | null | undefined, endTime: string | null | undefined, orderHint = 0) => {
      if (!startTime || !endTime) return;
      const key = `${startTime}|${endTime}`;
      if (byTime.has(key)) return;
      byTime.set(key, {
        id: dbIdByTime.get(key) ?? (100000 + byTime.size),
        startTime,
        endTime,
        order: orderHint,
      });
    };

    generatePolicySlotDefs(policy).forEach((s) => addSlot(s.startTime, s.endTime, s.order));

    // Snapshot the set of slot times produced by the policy definition alone.
    // Block/session occupied times are added below (when dateParam is set) and must
    // not be classified as policy slots. The client uses this to compute legacySlotIds.
    const policyOnlySlotTimes = [...byTime.keys()]; // e.g. ["08:06|09:06", "09:06|10:06", ...]

    if (dateParam) {
      const tz = schoolForPolicy?.timezone ?? 'UTC';
      const { from, to } = getWeekBoundaries(dateParam, tz);
      const [blocks, sessions] = await Promise.all([
        prisma.lessonBlock.findMany({
          where: {
            schoolId,
            deletedAt: null,
            status: 'UPCOMING',
            startDate: { lt: to },
            OR: [{ endDate: null }, { endDate: { gte: from } }],
          },
          select: { startTime: true, endTime: true, days: true, startDate: true, endDate: true },
        }),
        prisma.lessonSession.findMany({
          where: {
            schoolId,
            deletedAt: null,
            status: { not: 'INVALIDATED' },
            date: { gte: from, lt: to },
            lessonBlock: { deletedAt: null },
          },
          select: {
            date: true,
            startTimeSnap: true,
            endTimeSnap: true,
            lessonBlock: { select: { startTime: true, endTime: true, startDate: true, endDate: true } },
          },
        }),
      ]);
      const [weekY, weekM, weekD] = dateParam.split('-').map(Number);
      const weekDateStr = (offset: number) => {
        const d = new Date(Date.UTC(weekY, weekM - 1, weekD + offset));
        return d.toISOString().slice(0, 10);
      };
      const hasBlockOccurrenceInWeek = (block: typeof blocks[number]) => {
        if (!block.startTime || !block.endTime || block.days.length === 0) return false;
        const startStr = dateInTz(block.startDate, tz);
        const endStr = block.endDate ? dateInTz(block.endDate, tz) : null;
        for (let offset = 0; offset < 7; offset++) {
          const candidate = weekDateStr(offset);
          if (candidate < startStr || (endStr && candidate > endStr)) continue;
          const dayIdx = (new Date(`${candidate}T12:00:00.000Z`).getUTCDay() + 6) % 7;
          if (block.days.includes(dayIdx)) return true;
        }
        return false;
      };
      const isSessionInsideOwningBlockRange = (session: typeof sessions[number]) => {
        if (!session.lessonBlock) return false;
        const sessionStr = dateInTz(session.date, tz);
        const startStr = dateInTz(session.lessonBlock.startDate, tz);
        const endStr = session.lessonBlock.endDate ? dateInTz(session.lessonBlock.endDate, tz) : null;
        return sessionStr >= startStr && (!endStr || sessionStr <= endStr);
      };
      for (const b of blocks) {
        if (hasBlockOccurrenceInWeek(b)) addSlot(b.startTime, b.endTime, 1000);
      }
      for (const s of sessions) {
        if (!isSessionInsideOwningBlockRange(s)) continue;
        addSlot(s.startTimeSnap ?? s.lessonBlock?.startTime, s.endTimeSnap ?? s.lessonBlock?.endTime, 1000);
      }
    }

    const policySlots = [...byTime.values()]
      .sort((a, b) => a.startTime.localeCompare(b.startTime) || a.endTime.localeCompare(b.endTime))
      .map((slot, order) => ({ ...slot, order }));
    const policySlotTimes = policyOnlySlotTimes;
    const policyActiveDays = policy.activeDays.length > 0 ? policy.activeDays : [0, 1, 2, 3, 4, 5];
    // historical = true only when the requested week is strictly before the current week's Monday (UTC).
    // Schedule.tsx always passes ?date for the viewed week — using Boolean(dateParam) incorrectly
    // flagged the current week as archive/read-only.
    const now = new Date();
    const daysFromMonday = now.getUTCDay() === 0 ? 6 : now.getUTCDay() - 1;
    const currentWeekStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysFromMonday);
    const isHistorical = dateParam !== null && new Date(`${dateParam}T00:00:00.000Z`).getTime() < currentWeekStartMs;
    return res.json({ success: true, data: { slots: policySlots, activeDays: policyActiveDays, historical: isHistorical, policy, policySlotTimes } });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch timeslots' });
  }
});

// GET /api/settings/policy-impact — preview consequences of a proposed policy change.
// Call this before PATCH /settings to show admin the modal.
// Params: activeDays (required, comma-sep or array), workStart, workEnd, slotDuration (optional HH:MM / number)
// Returns: sessionsOutsideDays, sessionsOutsideHours, blocksOutsideDays, blocksOutsideHours,
//          affectedBlockIds, affectedGroups (itemized: group/level/reason/day),
//          policyEffectiveFrom (ISO), firstWorkingDate (YYYY-MM-DD)
router.get('/policy-impact', authenticate, requirePermission('settings:write'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId!;
    const rawDays = req.query.activeDays;
    const activeDays: number[] = Array.isArray(rawDays)
      ? rawDays.map(Number).filter(n => n >= 0 && n <= 6)
      : typeof rawDays === 'string'
        ? rawDays.split(',').map(Number).filter(n => n >= 0 && n <= 6)
        : [];

    if (activeDays.length === 0) {
      return res.status(400).json({ success: false, error: 'activeDays is required' });
    }

    const school = await prisma.school.findFirst({
      where: { id: schoolId, deletedAt: null },
      select: { timezone: true },
    });
    const tz = school?.timezone ?? 'UTC';
    // Mirror the PATCH /settings bootstrap rule: show today as effectiveFrom for new schools.
    const impactPolicyCount = await prisma.schoolSchedulePolicy.count({ where: { schoolId } });
    const { date: impactEffectiveDate } = impactPolicyCount === 0
      ? getTodayDateInTz(tz)
      : getNextMondayDateInTz(tz);

    const proposedWorkStart = typeof req.query.workStart === 'string' ? req.query.workStart : undefined;
    const proposedWorkEnd = typeof req.query.workEnd === 'string' ? req.query.workEnd : undefined;

    const impact = await computePolicyImpact(
      schoolId,
      { activeDays, workStart: proposedWorkStart, workEnd: proposedWorkEnd },
      impactEffectiveDate,
    );

    res.json({ success: true, data: impact });
  } catch (error) {
    log.error({ err: error }, 'compute policy impact error');
    res.status(500).json({ success: false, error: 'Failed to compute policy impact' });
  }
});

// GET /api/settings/cabinets
router.get('/cabinets', authenticate, async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user?.schoolId;
    const cabinets = await prisma.cabinet.findMany({
      where: { schoolId, deletedAt: null },
      include: { _count: { select: { blocks: { where: { deletedAt: null } } } } },
      orderBy: { name: 'asc' }
    });
    res.json({
      success: true,
      data: cabinets.map(({ _count, ...cab }) => ({ ...cab, usageCount: _count.blocks }))
    });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed' });
  }
});

// POST /api/settings/cabinets
router.post('/cabinets', authenticate, requirePermission('settings:write'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId!;
    const { name, capacity } = req.body;

    const existing = await prisma.cabinet.findFirst({ where: { name, schoolId, deletedAt: null } });
    if (existing) return res.status(400).json({ error: 'Кабинет уже существует' });

    const cabinet = await prisma.cabinet.create({
      data: { name, capacity: parseInt(capacity) || 15, schoolId }
    });
    res.json({ success: true, data: cabinet });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed' });
  }
});

// PATCH /api/settings/cabinets/:id — rename / change capacity
router.patch('/cabinets/:id', authenticate, requirePermission('settings:write'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId!;
    const id = parseInt(req.params.id);

    const cabinet = await prisma.cabinet.findFirst({ where: { id, schoolId, deletedAt: null } });
    if (!cabinet) return res.status(404).json({ error: 'Not found' });

    const name = typeof req.body.name === 'string' ? req.body.name.trim() : cabinet.name;
    if (!name) return res.status(400).json({ error: 'Название не может быть пустым' });
    const capacity = parseInt(req.body.capacity) || cabinet.capacity;

    if (name !== cabinet.name) {
      const existing = await prisma.cabinet.findFirst({ where: { name, schoolId, deletedAt: null, id: { not: id } } });
      if (existing) return res.status(400).json({ error: 'Кабинет уже существует' });
    }

    const updated = await prisma.cabinet.update({ where: { id }, data: { name, capacity } });
    res.json({ success: true, data: updated });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed' });
  }
});

// DELETE /api/settings/cabinets/:id
router.delete('/cabinets/:id', authenticate, requirePermission('settings:write'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId!;
    const id = parseInt(req.params.id);

    const cabinet = await prisma.cabinet.findFirst({ where: { id, schoolId, deletedAt: null } });
    if (!cabinet) return res.status(404).json({ error: 'Not found' });

    const usageCount = await prisma.lessonBlock.count({ where: { cabinetId: id, schoolId, deletedAt: null } });
    if (usageCount > 0) {
      return res.status(400).json({
        error: `Нельзя удалить кабинет — он используется в ${usageCount} занятиях`
      });
    }

    await prisma.cabinet.update({ where: { id }, data: { deletedAt: new Date() } });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed' });
  }
});

// GET /api/settings/group-size
router.get('/group-size', authenticate, async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user?.schoolId;
    const school = await prisma.school.findFirst({ where: { id: schoolId, deletedAt: null } });
    const settings: any = school?.settings || {};
    res.json({ success: true, data: settings.groupSize || 15 });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed' });
  }
});

// PATCH /api/settings/group-size
router.patch('/group-size', authenticate, requirePermission('settings:write'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId!;
    const { size } = req.body;

    const school = await prisma.school.findFirst({ where: { id: schoolId, deletedAt: null } });
    const settings: any = school?.settings || {};

    await prisma.school.update({
      where: { id: schoolId },
      data: { settings: { ...settings, groupSize: parseInt(size) } }
    });
    res.json({ success: true, data: size });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed' });
  }
});

// DELETE /api/settings/clear-all-data
// OWNER-only: explicit role check, not just permission (users:manage could theoretically expand)
// Requires: reason in body, ALLOW_CLEAR_ALL_DATA=true env flag in production
router.delete('/clear-all-data', authenticate, requirePermission('users:manage'), async (req: AuthRequest, res) => {
  try {
    // Explicit role guard — only OWNER (or SUPERADMIN for platform ops) may clear all data
    const role = req.user!.role;
    if (role !== Role.OWNER && role !== Role.SUPERADMIN) {
      return res.status(403).json({ success: false, error: 'Forbidden: OWNER role required' });
    }

    if (!canClearAllData()) {
      await logSecurityEvent({
        event: 'CLEAR_ALL_DATA_BLOCKED',
        schoolId: req.user!.schoolId,
        userId: req.user!.userId,
        details: { reason: 'ALLOW_CLEAR_ALL_DATA not set in production' },
        req,
      });
      return res.status(403).json({
        success: false,
        error: 'CLEAR_ALL_DATA_DISABLED_IN_PRODUCTION',
      });
    }

    const { reason } = req.body as { reason?: string };
    if (!reason || typeof reason !== 'string' || reason.trim().length < 5) {
      return res.status(400).json({
        success: false,
        error: 'reason is required (min 5 characters)',
      });
    }

    const schoolId = req.user!.schoolId!;

    // Audit log BEFORE any deletion — immutable record of who ordered the wipe and why
    await logSecurityEvent({
      event: 'CLEAR_ALL_DATA',
      schoolId,
      userId: req.user!.userId,
      details: { reason: reason.trim() },
      req,
    });

    const now = new Date();

    // Fetch IDs first — updateMany only supports scalar WHERE filters, not nested relations
    const [spIds, staffIds] = await Promise.all([
      prisma.studentProfile.findMany({ where: { user: { schoolId } }, select: { id: true } }).then(r => r.map(x => x.id)),
      prisma.staffProfile.findMany({ where: { user: { schoolId, role: Role.TEACHER } }, select: { id: true } }).then(r => r.map(x => x.id)),
    ]);

    // Soft-delete all operational data — records stay in DB, just hidden from UI via deletedAt
    await Promise.all([
      prisma.lessonSession.updateMany({ where: { schoolId, deletedAt: null }, data: { deletedAt: now } }),
      prisma.lessonBlock.updateMany({ where: { schoolId, deletedAt: null }, data: { deletedAt: now } }),
      prisma.studentGroup.updateMany({ where: { schoolId, deletedAt: null }, data: { deletedAt: now } }),
      // Close active memberships so they never point to a soft-deleted group.
      // Invariant: status=ACTIVE ⇒ studentGroup.deletedAt IS NULL.
      prisma.groupMembership.updateMany({
        where: { schoolId, status: 'ACTIVE' },
        data: { status: 'WITHDRAWN', leftAt: now, leftReason: 'SCHOOL_DATA_CLEARED' },
      }),
      prisma.cabinet.updateMany({ where: { schoolId, deletedAt: null }, data: { deletedAt: now } }),
      ...(spIds.length > 0 ? [prisma.studentProfile.updateMany({ where: { id: { in: spIds }, deletedAt: null }, data: { deletedAt: now } })] : []),
      ...(staffIds.length > 0 ? [prisma.staffProfile.updateMany({ where: { id: { in: staffIds }, deletedAt: null }, data: { deletedAt: now } })] : []),
    ]);

    await prisma.user.updateMany({
      where: { schoolId, role: { in: [Role.STUDENT, Role.TEACHER] }, deletedAt: null },
      data: { deletedAt: now },
    });

    res.json({ success: true, message: 'Все данные успешно очищены' });
  } catch (error: any) {
    // Full error (incl. Prisma error.meta, which can contain raw column/constraint
    // names) goes to the server log only — never to the client response.
    log.error({ err: error }, 'clear-all-data error');
    res.status(500).json({ success: false, error: 'Ошибка при очистке данных' });
  }
});

// ─── Finance Config ───────────────────────────────────────────────────────────

// GET /api/settings/finance — возвращает финансовую конфигурацию школы (upsert с дефолтами)
router.get('/finance', authenticate, requirePermission('settings:read'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId!;
    const config = await prisma.schoolFinanceConfig.upsert({
      where: { schoolId },
      create: { schoolId, updatedAt: new Date() },
      update: {},
      select: {
        basePrice: true,
        billingDays: true,
        billingMode: true,
        pricePerLesson: true,
        currency: true,
        defaultSalaryRate: true,
        paymentCash: true,
        paymentCard: true,
        paymentMbank: true,
        paymentOptima: true,
        mbankNumber: true,
        paymentReceiver: true,
        updatedAt: true,
        // deprecated: freezeWindowHours, freezeDeadlineHours, allowStudentSelfFreeze — live in School.settings.pauseRules
      },
    });
    res.json({ success: true, data: config });
  } catch (error) {
    log.error({ err: error }, 'fetch finance config error');
    res.status(500).json({ success: false, error: 'Failed to fetch finance config' });
  }
});

// PATCH /api/settings/finance — обновляет финансовую конфигурацию (только OWNER/SUPERADMIN)
router.patch('/finance', authenticate, requirePermission('settings:write'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId!;
    if (req.user!.role !== 'OWNER' && req.user!.role !== 'SUPERADMIN') {
      return res.status(403).json({ success: false, error: 'Forbidden: OWNER role required' });
    }
    const {
      basePrice, billingDays, billingMode, currency,
      defaultSalaryRate,
      paymentCash, paymentCard, paymentMbank, paymentOptima,
      mbankNumber, paymentReceiver,
    } = req.body;
    // freezeWindowHours / freezeDeadlineHours / allowStudentSelfFreeze are deprecated —
    // pause rules live in School.settings.pauseRules via PATCH /settings/pause

    if (billingMode !== undefined && !Object.values(BillingMode).includes(billingMode)) {
      return res.status(400).json({ success: false, error: 'Invalid billingMode' });
    }

    const data: Record<string, unknown> = {
      updatedAt: new Date(),
      updatedById: req.user!.userId,
    };

    const bp = basePrice !== undefined ? parseFloat(basePrice) : undefined;
    const bd = billingDays !== undefined ? parseInt(billingDays) : undefined;
    if (bp !== undefined) data.basePrice    = bp;
    if (bd !== undefined) data.billingDays  = bd;
    if (billingMode !== undefined) data.billingMode = billingMode as BillingMode;
    if (bp !== undefined || bd !== undefined) {
      // Re-derive pricePerLesson whenever either input changes — a stale price
      // would silently miscount credits on every future quick payment.
      const existingCfg = await prisma.schoolFinanceConfig.findUnique({
        where: { schoolId },
        select: { basePrice: true, billingDays: true },
      });
      const effBp = bp ?? Number(existingCfg?.basePrice ?? 5000);
      const effBd = bd ?? existingCfg?.billingDays ?? 26;
      data.pricePerLesson = Math.ceil(effBp / (effBd || 1));
    }
    if (currency !== undefined)          data.currency          = String(currency);
    if (defaultSalaryRate !== undefined) data.defaultSalaryRate = parseFloat(defaultSalaryRate);
    if (paymentCash !== undefined)       data.paymentCash       = Boolean(paymentCash);
    if (paymentCard !== undefined)       data.paymentCard       = Boolean(paymentCard);
    if (paymentMbank !== undefined)      data.paymentMbank      = Boolean(paymentMbank);
    if (paymentOptima !== undefined)     data.paymentOptima     = Boolean(paymentOptima);
    if (mbankNumber !== undefined)       data.mbankNumber       = mbankNumber || null;
    if (paymentReceiver !== undefined)   data.paymentReceiver   = paymentReceiver || null;

    // Detect a billingMode change so we can re-derive every student's paidUntil
    // (the projection formula differs between modes).
    let modeChanged = false;
    if (billingMode !== undefined) {
      const existing = await prisma.schoolFinanceConfig.findUnique({
        where: { schoolId },
        select: { billingMode: true },
      });
      modeChanged = (existing?.billingMode ?? BillingMode.PER_LESSON) !== billingMode;
    }

    const config = await prisma.schoolFinanceConfig.upsert({
      where: { schoolId },
      create: { schoolId, ...data },
      update: data,
    });

    if (modeChanged) {
      try {
        const { checked, changed } = await recomputePaidUntilForSchool(prisma, schoolId);
        log.info({ schoolId, billingMode, checked, changed }, 'paidUntil recomputed after billingMode change');
      } catch (e) {
        log.error({ err: e, schoolId }, 'failed to recompute paidUntil after billingMode change');
      }
    }

    res.json({ success: true, data: config });
  } catch (error) {
    log.error({ err: error }, 'update finance config error');
    res.status(500).json({ success: false, error: 'Failed to update finance config' });
  }
});

// GET /api/settings/general — school name, address, phone, email, docLabel, currency
// name/address/phone/email are the real School columns (source of truth — same ones set
// at registration and editable via PUT /schools/current/me). docLabel/currency have no
// dedicated column and stay in settings.generalInfo.
// Readable by any authenticated school member; currency shown on Overview for all roles.
router.get('/general', authenticate, async (req: AuthRequest, res) => {
  try {
    const school = await prisma.school.findFirst({
      where: { id: req.user!.schoolId!, deletedAt: null },
      select: { name: true, address: true, phone: true, email: true, logoUrl: true, description: true, settings: true },
    });
    if (!school) return res.status(404).json({ success: false, error: 'School not found' });
    const s = school.settings && typeof school.settings === 'object' && !Array.isArray(school.settings) ? school.settings as Record<string, unknown> : {};
    const g = (s.generalInfo as Record<string, unknown> | undefined) ?? {};
    const lc = (s.landingConfig as Record<string, unknown> | undefined) ?? {};
    res.json({ success: true, data: {
      name:     school.name    ?? '',
      address:  school.address ?? '',
      phone:    school.phone   ?? '',
      email:    school.email   ?? '',
      docLabel: typeof g.docLabel === 'string' ? g.docLabel : 'Квитанция',
      currency: typeof g.currency === 'string' ? g.currency : 'KGS',
      logoUrl:      school.logoUrl ?? '',
      description:  school.description ?? '',
      heroImageUrl: typeof lc.heroImageUrl === 'string' ? lc.heroImageUrl : '',
    }});
  } catch (error) {
    log.error({ err: error }, 'settings/general GET error');
    res.status(500).json({ success: false, error: 'Failed to fetch general settings' });
  }
});

// School.email is the school's own contact address (shown on receipts/notifications) —
// a plain column, unrelated to User.email which is the actual login credential.
const SCHOOL_EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// PATCH /api/settings/general — OWNER/ADMIN (settings:write)
router.patch('/general', authenticate, requirePermission('settings:write'), async (req: AuthRequest, res) => {
  try {
    const schoolId = req.user!.schoolId!;
    const { name, address, phone, email, docLabel, currency } = req.body;

    const school = await prisma.school.findFirst({ where: { id: schoolId, deletedAt: null }, select: { id: true, settings: true } });
    if (!school) return res.status(404).json({ success: false, error: 'School not found' });

    const current = school.settings && typeof school.settings === 'object' && !Array.isArray(school.settings) ? school.settings as Record<string, unknown> : {};
    const existing = (current.generalInfo as Record<string, unknown> | undefined) ?? {};

    const generalInfo: Record<string, string> = {
      docLabel: typeof docLabel === 'string' ? docLabel.trim() : (existing.docLabel as string ?? 'Квитанция'),
      currency: typeof currency === 'string' ? currency.trim() : (existing.currency as string ?? 'KGS'),
    };

    const schoolUpdate: Prisma.SchoolUpdateInput = {};
    if (typeof name === 'string') {
      const trimmed = name.trim();
      if (!trimmed) return res.status(400).json({ success: false, error: 'Название школы не может быть пустым' });
      schoolUpdate.name = trimmed;
    }
    if (typeof address === 'string') schoolUpdate.address = address.trim() || null;
    if (typeof phone === 'string') schoolUpdate.phone = phone.trim() || null;
    if (typeof email === 'string') {
      const trimmed = email.trim();
      if (!SCHOOL_EMAIL_REGEX.test(trimmed)) {
        return res.status(400).json({ success: false, error: 'Некорректный email' });
      }
      schoolUpdate.email = trimmed;
    }

    let updated;
    try {
      updated = await prisma.school.update({
        where: { id: schoolId },
        data: {
          ...schoolUpdate,
          settings: { ...current, generalInfo } as Prisma.InputJsonObject,
        },
        select: { name: true, address: true, phone: true, email: true },
      });
    } catch (updateError) {
      if (updateError instanceof Prisma.PrismaClientKnownRequestError && updateError.code === 'P2002') {
        return res.status(400).json({ success: false, error: 'Этот email уже используется другой школой' });
      }
      throw updateError;
    }

    res.json({ success: true, data: {
      name: updated.name ?? '',
      address: updated.address ?? '',
      phone: updated.phone ?? '',
      email: updated.email ?? '',
      ...generalInfo,
    }});
  } catch (error) {
    log.error({ err: error }, 'settings/general PATCH error');
    res.status(500).json({ success: false, error: 'Failed to save general settings' });
  }
});

// GET /api/settings/pause — pause rules stored in School.settings.pauseRules
router.get('/pause', authenticate, async (req: AuthRequest, res) => {
  try {
    const school = await prisma.school.findFirst({ where: { id: req.user!.schoolId!, deletedAt: null }, select: { settings: true } });
    if (!school) return res.status(404).json({ success: false, error: 'School not found' });
    const s = school.settings && typeof school.settings === 'object' && !Array.isArray(school.settings) ? school.settings as Record<string, unknown> : {};
    const rules = (s.pauseRules as Record<string, unknown> | undefined) ?? {};
    res.json({ success: true, data: {
      allowed:      rules.allowed !== false,
      maxDays:      parsePauseInt(rules.maxDays, null),
      minNotice:    typeof rules.minNotice === 'number' ? rules.minNotice : 3,
      timesPerYear: parsePauseInt(rules.timesPerYear, null),
    }});
  } catch (error) {
    log.error({ err: error }, 'settings/pause GET error');
    res.status(500).json({ success: false, error: 'Failed to fetch pause settings' });
  }
});

// PATCH /api/settings/pause — update pause rules (OWNER/ADMIN/SUPERADMIN via settings:write)
router.patch('/pause', authenticate, requirePermission('settings:write'), async (req: AuthRequest, res) => {
  try {
    const school = await prisma.school.findFirst({ where: { id: req.user!.schoolId!, deletedAt: null }, select: { id: true, settings: true } });
    if (!school) return res.status(404).json({ success: false, error: 'School not found' });
    const { allowed, maxDays, minNotice, timesPerYear } = req.body;

    // Type validation — reject string values
    if (maxDays !== undefined && maxDays !== null && typeof maxDays !== 'number') {
      return res.status(400).json({ success: false, error: 'maxDays must be a number or null' });
    }
    if (timesPerYear !== undefined && timesPerYear !== null && typeof timesPerYear !== 'number') {
      return res.status(400).json({ success: false, error: 'timesPerYear must be a number or null' });
    }
    if (minNotice !== undefined && typeof minNotice !== 'number') {
      return res.status(400).json({ success: false, error: 'minNotice must be a number' });
    }
    // Range validation
    if (typeof maxDays === 'number' && maxDays < 1) {
      return res.status(400).json({ success: false, error: 'maxDays must be >= 1' });
    }
    if (typeof timesPerYear === 'number' && timesPerYear < 1) {
      return res.status(400).json({ success: false, error: 'timesPerYear must be >= 1' });
    }
    if (typeof minNotice === 'number' && minNotice < 0) {
      return res.status(400).json({ success: false, error: 'minNotice must be >= 0' });
    }

    const current = school.settings && typeof school.settings === 'object' && !Array.isArray(school.settings) ? school.settings as Record<string, unknown> : {};
    const pauseRules = {
      allowed:      allowed !== false,
      maxDays:      maxDays      !== undefined ? maxDays      : null,
      minNotice:    typeof minNotice === 'number' ? minNotice : 3,
      timesPerYear: timesPerYear !== undefined ? timesPerYear : null,
    };
    await prisma.school.update({
      where: { id: school.id },
      data: { settings: { ...current, pauseRules } as Prisma.InputJsonObject },
    });
    res.json({ success: true, data: pauseRules });
  } catch (error) {
    log.error({ err: error }, 'settings/pause PATCH error');
    res.status(500).json({ success: false, error: 'Failed to save pause settings' });
  }
});

// ─── Webhooks ─────────────────────────────────────────────────────────────────

// Attribution, pixels, webhooks, and integration placeholders.
router.get('/attribution', authenticate, requirePermission('attribution:read'), async (req: AuthRequest, res) => {
  const school = await prisma.school.findFirst({ where: { id: req.user!.schoolId!, deletedAt: null }, select: { settings: true } });
  if (!school) return res.status(404).json({ success: false, error: 'School not found' });
  res.json({ success: true, data: readAttributionSettings(school.settings) });
});

router.patch('/attribution', authenticate, requirePermission('attribution:write'), async (req: AuthRequest, res) => {
  try {
    const school = await prisma.school.findFirst({ where: { id: req.user!.schoolId!, deletedAt: null }, select: { id: true, settings: true } });
    if (!school) return res.status(404).json({ success: false, error: 'School not found' });
    const attribution = sanitizeAttributionSettingsInput(req.body);
    const current = school.settings && typeof school.settings === 'object' && !Array.isArray(school.settings) ? school.settings as Record<string, unknown> : {};
    await prisma.school.update({
      where: { id: school.id },
      data: { settings: { ...current, attribution: attribution as unknown as Prisma.InputJsonObject } as Prisma.InputJsonObject },
    });
    res.json({ success: true, data: attribution });
  } catch (error) {
    if (error instanceof AttributionSettingsError) return res.status(400).json({ success: false, error: error.message });
    res.status(500).json({ success: false, error: 'Failed to update attribution settings' });
  }
});

router.get('/pixels', authenticate, requirePermission('pixels:read'), async (req: AuthRequest, res) => {
  const school = await prisma.school.findFirst({ where: { id: req.user!.schoolId!, deletedAt: null }, select: { settings: true } });
  if (!school) return res.status(404).json({ success: false, error: 'School not found' });
  res.json({ success: true, data: readPixelSettings(school.settings) });
});

router.patch('/pixels', authenticate, requirePermission('pixels:write'), async (req: AuthRequest, res) => {
  try {
    const school = await prisma.school.findFirst({ where: { id: req.user!.schoolId!, deletedAt: null }, select: { id: true, settings: true } });
    if (!school) return res.status(404).json({ success: false, error: 'School not found' });
    const pixels = sanitizePixelSettingsInput(req.body);
    const current = school.settings && typeof school.settings === 'object' && !Array.isArray(school.settings) ? school.settings as Record<string, unknown> : {};
    await prisma.school.update({
      where: { id: school.id },
      data: { settings: { ...current, pixels: pixels as unknown as Prisma.InputJsonObject } as Prisma.InputJsonObject },
    });
    res.json({ success: true, data: pixels });
  } catch (error) {
    if (error instanceof PixelSettingsError) return res.status(400).json({ success: false, error: error.message });
    res.status(500).json({ success: false, error: 'Failed to update pixel settings' });
  }
});

// ─── Help topics ────────────────────────────────────────────────────────────────
// Platform-wide, not school-scoped: authored by SUPERADMIN (see routes/superadmin.ts
// PATCH /superadmin/help), shown to every role on every school's shared /help page.
router.get('/help', authenticate, async (req: AuthRequest, res) => {
  const settings = await prisma.platformSettings.findUnique({ where: { id: 1 }, select: { help: true } });
  res.json({ success: true, data: readHelpTopics({ help: settings?.help ?? [] }) });
});

router.get('/webhooks', authenticate, requirePermission('webhooks:read'), async (req: AuthRequest, res) => {
  const webhooks = await prisma.webhook.findMany({ where: { schoolId: req.user!.schoolId! }, select: WEBHOOK_SELECT, orderBy: { createdAt: 'desc' } });
  res.json({ success: true, data: webhooks.map(serializeWebhook) });
});

router.post('/webhooks', authenticate, requirePermission('webhooks:write'), async (req: AuthRequest, res) => {
  try {
    const secret = generateWebhookSecret();
    const wh = await prisma.webhook.create({
      data: {
        schoolId: req.user!.schoolId!,
        url: validateWebhookUrl(req.body?.url),
        events: sanitizeWebhookEvents(req.body?.events),
        secret,
      },
      select: WEBHOOK_SELECT,
    });
    res.status(201).json({ success: true, data: { webhook: serializeWebhook(wh), secretOnce: secret } });
  } catch (error) {
    if (error instanceof WebhookEventError || error instanceof WebhookUrlError) return res.status(400).json({ success: false, error: error.message });
    res.status(500).json({ success: false, error: 'Failed to create webhook' });
  }
});

router.patch('/webhooks/:id', authenticate, requirePermission('webhooks:write'), async (req: AuthRequest, res) => {
  try {
    const id = parseNumericId(req.params.id);
    if (!id) return res.status(400).json({ success: false, error: 'Invalid webhook id' });
    const schoolId = req.user!.schoolId!;
    const data: Prisma.WebhookUpdateInput = {};
    if ('url' in req.body) data.url = validateWebhookUrl(req.body.url);
    if ('events' in req.body) data.events = sanitizeWebhookEvents(req.body.events);
    if ('isActive' in req.body) data.isActive = Boolean(req.body.isActive);
    // schoolId in where prevents cross-tenant update; P2025 is caught as 404 below
    const webhook = await prisma.webhook.update({ where: { id, schoolId }, data, select: WEBHOOK_SELECT });
    res.json({ success: true, data: serializeWebhook(webhook) });
  } catch (error) {
    if (error instanceof WebhookEventError || error instanceof WebhookUrlError) return res.status(400).json({ success: false, error: error.message });
    if (isPrismaNotFound(error)) return res.status(404).json({ success: false, error: 'Webhook not found' });
    res.status(500).json({ success: false, error: 'Failed to update webhook' });
  }
});

router.post('/webhooks/:id/rotate-secret', authenticate, requirePermission('secrets:rotate'), async (req: AuthRequest, res) => {
  try {
    const id = parseNumericId(req.params.id);
    if (!id) return res.status(400).json({ success: false, error: 'Invalid webhook id' });
    const schoolId = req.user!.schoolId!;
    const secret = generateWebhookSecret();
    // schoolId in where prevents cross-tenant secret rotation
    const webhook = await prisma.webhook.update({ where: { id, schoolId }, data: { secret, secretRotatedAt: new Date() }, select: WEBHOOK_SELECT });
    await logSecurityEvent({
      event: 'WEBHOOK_SECRET_ROTATED',
      schoolId,
      userId: req.user!.userId,
      details: { webhookId: id },
      req,
    });
    res.json({ success: true, data: { webhook: serializeWebhook(webhook), secretOnce: secret } });
  } catch (error) {
    if (isPrismaNotFound(error)) return res.status(404).json({ success: false, error: 'Webhook not found' });
    res.status(500).json({ success: false, error: 'Failed to rotate secret' });
  }
});

router.post('/webhooks/:id/test', authenticate, requirePermission('webhooks:write'), async (req: AuthRequest, res) => {
  const id = parseNumericId(req.params.id);
  if (!id) return res.status(400).json({ success: false, error: 'Invalid webhook id' });
  const delivery = await deliverWebhookForTest({ schoolId: req.user!.schoolId!, webhookId: id, payload: { message: 'Test webhook from Shamdan', schoolId: req.user!.schoolId! } });
  if (!delivery) return res.status(404).json({ success: false, error: 'Webhook not found' });
  res.json({ success: delivery.status === 'delivered', data: delivery });
});

router.get('/webhooks/:id/deliveries', authenticate, requirePermission('webhooks:read'), async (req: AuthRequest, res) => {
  const id = parseNumericId(req.params.id);
  if (!id) return res.status(400).json({ success: false, error: 'Invalid webhook id' });
  const deliveries = await prisma.webhookDelivery.findMany({ where: { webhookId: id, schoolId: req.user!.schoolId! }, orderBy: { createdAt: 'desc' }, take: 50 });
  res.json({ success: true, data: deliveries });
});

router.delete('/webhooks/:id', authenticate, requirePermission('webhooks:write'), async (req: AuthRequest, res) => {
  const id = parseNumericId(req.params.id);
  if (!id) return res.status(400).json({ success: false, error: 'Invalid webhook id' });
  await prisma.webhook.deleteMany({ where: { id, schoolId: req.user!.schoolId! } });
  res.json({ success: true });
});

router.get('/integrations/providers', authenticate, requirePermission('integrations:read'), (_req: AuthRequest, res) => {
  res.json({ success: true, data: listIntegrationProviders() });
});

router.get('/integrations', authenticate, requirePermission('integrations:read'), async (req: AuthRequest, res) => {
  const connections = await prisma.integrationConnection.findMany({
    where: { schoolId: req.user!.schoolId!, provider: { in: INTEGRATION_PROVIDERS.map(provider => provider.key) } },
    select: INTEGRATION_CONNECTION_SELECT,
    orderBy: { updatedAt: 'desc' },
  });
  const byProvider = new Map(connections.map(connection => [connection.provider, connection]));
  res.json({ success: true, data: INTEGRATION_PROVIDERS.map(provider => serializeIntegrationCard(byProvider.get(provider.key), provider)) });
});

router.get('/integrations/:id/events', authenticate, requirePermission('integrations:read'), async (req: AuthRequest, res) => {
  const id = parseNumericId(req.params.id);
  if (!id) return res.status(400).json({ success: false, error: 'Invalid integration id' });
  const events = await prisma.integrationSyncLog.findMany({ where: { schoolId: req.user!.schoolId!, connectionId: id }, orderBy: { createdAt: 'desc' }, take: 50 });
  res.json({ success: true, data: events });
});

router.post('/integrations/:provider/connect', authenticate, requirePermission('integrations:write'), async (req: AuthRequest, res) => {
  if (hasCredentialFields(req.body)) return res.status(400).json({ success: false, error: 'Credentials are not accepted for manual integration placeholders' });
  const provider = getIntegrationProvider(req.params.provider);
  if (!provider) return res.status(400).json({ success: false, error: 'Unsupported integration provider' });
  const existing = await prisma.integrationConnection.findFirst({ where: { schoolId: req.user!.schoolId!, provider: provider.key }, select: INTEGRATION_CONNECTION_SELECT });
  const data = {
    schoolId: req.user!.schoolId!,
    provider: provider.key,
    category: provider.category,
    status: getManualConnectionStatus(provider),
    enabled: true,
    displayName: sanitizeIntegrationDisplayName(req.body?.displayName) ?? provider.displayName,
    credentialStatus: getDefaultCredentialStatus(provider),
    connectedAt: new Date(),
    disconnectedAt: null,
  };
  const connection = existing
    ? await prisma.integrationConnection.update({ where: { id: existing.id }, data, select: INTEGRATION_CONNECTION_SELECT })
    : await prisma.integrationConnection.create({ data, select: INTEGRATION_CONNECTION_SELECT });
  await prisma.integrationSyncLog.create({ data: { schoolId: req.user!.schoolId!, connectionId: connection.id, provider: provider.key, eventType: 'manual.connect', status: 'success', message: sanitizeIntegrationMessage('Manual placeholder connected'), occurredAt: new Date() } });
  res.status(201).json({ success: true, data: { connection: sanitizeIntegrationConnection(connection) } });
});

router.patch('/integrations/:id', authenticate, requirePermission('integrations:write'), async (req: AuthRequest, res) => {
  const id = parseNumericId(req.params.id);
  if (!id) return res.status(400).json({ success: false, error: 'Invalid integration id' });
  if (hasCredentialFields(req.body)) return res.status(400).json({ success: false, error: 'Credentials are not accepted for integration updates' });
  const schoolId = req.user!.schoolId!;
  const existing = await prisma.integrationConnection.findFirst({ where: { id, schoolId }, select: INTEGRATION_CONNECTION_SELECT });
  if (!existing) return res.status(404).json({ success: false, error: 'Integration not found' });
  const provider = getIntegrationProvider(existing.provider);
  if (!provider) return res.status(400).json({ success: false, error: 'Unsupported integration provider' });
  const data: Prisma.IntegrationConnectionUpdateInput = {};
  const nextEnabled = typeof req.body?.enabled === 'boolean' ? req.body.enabled : undefined;
  if (nextEnabled !== undefined) data.enabled = nextEnabled;
  if ('displayName' in req.body) data.displayName = sanitizeIntegrationDisplayName(req.body.displayName) ?? null;
  if ('status' in req.body && !isIntegrationStatus(req.body.status)) return res.status(400).json({ success: false, error: 'Unsupported integration status' });
  const nextStatus = getIntegrationUpdateStatus({ enabled: nextEnabled, requestedStatus: req.body?.status, previousStatus: existing.status, provider });
  if (nextStatus) data.status = nextStatus;
  // schoolId in where prevents TOCTOU between findFirst and update
  const updated = await prisma.integrationConnection.update({ where: { id, schoolId }, data, select: INTEGRATION_CONNECTION_SELECT });
  res.json({ success: true, data: sanitizeIntegrationConnection(updated) });
});

router.post('/integrations/:id/disconnect', authenticate, requirePermission('integrations:write'), async (req: AuthRequest, res) => {
  try {
    const id = parseNumericId(req.params.id);
    if (!id) return res.status(400).json({ success: false, error: 'Invalid integration id' });
    const schoolId = req.user!.schoolId!;
    // schoolId in where prevents cross-tenant disconnect; P2025 caught as 404
    const updated = await prisma.integrationConnection.update({ where: { id, schoolId }, data: { enabled: false, status: INTEGRATION_STATUS.disconnected, disconnectedAt: new Date() }, select: INTEGRATION_CONNECTION_SELECT });
    await prisma.integrationSyncLog.create({ data: { schoolId, connectionId: id, provider: updated.provider, eventType: 'manual.disconnect', status: 'success', message: 'Manual placeholder disconnected' } });
    res.json({ success: true, data: sanitizeIntegrationConnection(updated) });
  } catch (error) {
    if (isPrismaNotFound(error)) return res.status(404).json({ success: false, error: 'Integration not found' });
    res.status(500).json({ success: false, error: 'Failed to disconnect integration' });
  }
});

router.post('/integrations/:id/test', authenticate, requirePermission('integrations:write'), async (req: AuthRequest, res) => {
  const id = parseNumericId(req.params.id);
  if (!id) return res.status(400).json({ success: false, error: 'Invalid integration id' });
  const existing = await prisma.integrationConnection.findFirst({ where: { id, schoolId: req.user!.schoolId! }, select: INTEGRATION_CONNECTION_SELECT });
  if (!existing) return res.status(404).json({ success: false, error: 'Integration not found' });
  const status: IntegrationLogStatus = isIntegrationProvider(existing.provider) ? 'success' : 'warning';
  await prisma.integrationSyncLog.create({ data: { schoolId: req.user!.schoolId!, connectionId: id, provider: existing.provider, eventType: 'manual.test', status, message: 'Integration test placeholder completed', occurredAt: new Date() } });
  res.json({ success: true, data: { status, message: 'Integration test placeholder completed' } });
});

router.post('/integrations/:id/sync', authenticate, requirePermission('integrations:write'), async (req: AuthRequest, res) => {
  const id = parseNumericId(req.params.id);
  if (!id) return res.status(400).json({ success: false, error: 'Invalid integration id' });
  const existing = await prisma.integrationConnection.findFirst({ where: { id, schoolId: req.user!.schoolId! }, select: INTEGRATION_CONNECTION_SELECT });
  if (!existing) return res.status(404).json({ success: false, error: 'Integration not found' });
  const updated = await prisma.integrationConnection.update({ where: { id, schoolId: req.user!.schoolId! }, data: { lastSyncAt: new Date(), status: existing.enabled ? INTEGRATION_STATUS.connected : existing.status }, select: INTEGRATION_CONNECTION_SELECT });
  await prisma.integrationSyncLog.create({ data: { schoolId: req.user!.schoolId!, connectionId: id, provider: existing.provider, eventType: 'manual.sync', status: 'skipped', message: 'No real provider sync is implemented yet', occurredAt: new Date() } });
  res.json({ success: true, data: { connection: sanitizeIntegrationConnection(updated), message: 'Integration sync placeholder completed' } });
});

export default router;
