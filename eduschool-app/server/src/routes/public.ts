import { Router } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma';
import {
  AttributionInput,
  cleanString,
  normalizeLeadSource,
  readAttributionSettings,
  sanitizeRawParams,
} from '../lib/leadAttribution';
import { dispatchWebhook } from '../lib/webhooks';
import { createLogger } from '../lib/logger';

const log = createLogger('public');
const router = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function bodyString(body: Record<string, unknown>, key: string, max?: number): string | undefined {
  return cleanString(body[key], max);
}

function buildAttribution(body: Record<string, unknown>): AttributionInput {
  return {
    source: bodyString(body, 'source', 80),
    utmSource: bodyString(body, 'utm_source', 120) ?? bodyString(body, 'utmSource', 120),
    utmMedium: bodyString(body, 'utm_medium', 120) ?? bodyString(body, 'utmMedium', 120),
    utmCampaign: bodyString(body, 'utm_campaign', 180) ?? bodyString(body, 'utmCampaign', 180),
    utmContent: bodyString(body, 'utm_content', 180) ?? bodyString(body, 'utmContent', 180),
    utmTerm: bodyString(body, 'utm_term', 180) ?? bodyString(body, 'utmTerm', 180),
    referrer: bodyString(body, 'referrer', 500),
    landingPage: bodyString(body, 'landingPage', 500) ?? bodyString(body, 'landing_page', 500),
    gclid: bodyString(body, 'gclid', 180),
    fbclid: bodyString(body, 'fbclid', 180),
    yclid: bodyString(body, 'yclid', 180),
    ttclid: bodyString(body, 'ttclid', 180),
    rawParams: sanitizeRawParams(body.rawParams),
  };
}

function splitName(name: string | undefined, firstName?: string, lastName?: string) {
  if (firstName || lastName) return { firstName, lastName };
  if (!name) return { firstName: undefined, lastName: undefined };
  const parts = name.split(/\s+/).filter(Boolean);
  return {
    firstName: parts.shift()?.slice(0, 80),
    lastName: parts.join(' ').slice(0, 80) || undefined,
  };
}

router.post('/:slug/leads', async (req, res) => {
  try {
    const slug = cleanString(req.params.slug, 120);
    if (!slug || !req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ success: false, error: 'Invalid request' });
    }

    const body = req.body as Record<string, unknown>;
    const name = bodyString(body, 'name', 160);
    const explicitFirstName = bodyString(body, 'firstName', 80);
    const explicitLastName = bodyString(body, 'lastName', 80);
    const phone = bodyString(body, 'phone', 40);
    const email = bodyString(body, 'email', 160)?.toLowerCase();
    const note = bodyString(body, 'message', 1000) ?? bodyString(body, 'comment', 1000);

    if (!phone && !email) {
      return res.status(400).json({ success: false, error: 'Phone or email is required' });
    }
    if (email && !EMAIL_RE.test(email)) {
      return res.status(400).json({ success: false, error: 'Invalid email' });
    }

    const school = await prisma.school.findFirst({
      where: { slug, deletedAt: null, isActive: true },
      select: { id: true, settings: true },
    });
    if (!school) {
      return res.status(404).json({ success: false, error: 'School not found' });
    }

    const attribution = buildAttribution(body);
    const source = normalizeLeadSource(attribution, readAttributionSettings(school.settings));
    const { firstName, lastName } = splitName(name, explicitFirstName, explicitLastName);
    const now = new Date();

    const lead = await prisma.$transaction(async tx => {
      let campaignId: number | undefined;
      if (attribution.utmCampaign) {
        const existing = await tx.marketingCampaign.findFirst({
          where: { schoolId: school.id, name: attribution.utmCampaign, source },
          select: { id: true },
        });
        const campaign = existing ?? (await tx.marketingCampaign.create({
          data: { schoolId: school.id, name: attribution.utmCampaign, source },
          select: { id: true },
        }));
        campaignId = campaign.id;
      }

      const created = await tx.lead.create({
        data: {
          schoolId: school.id,
          campaignId,
          firstName,
          lastName,
          phone,
          email,
          note,
          source,
        },
        select: { id: true, source: true, status: true, createdAt: true },
      });

      await tx.leadAttribution.create({
        data: {
          schoolId: school.id,
          leadId: created.id,
          touchType: 'lead_capture',
          utmSource: attribution.utmSource,
          utmMedium: attribution.utmMedium,
          utmCampaign: attribution.utmCampaign,
          utmContent: attribution.utmContent,
          utmTerm: attribution.utmTerm,
          referrer: attribution.referrer,
          landingPage: attribution.landingPage,
          gclid: attribution.gclid,
          fbclid: attribution.fbclid,
          yclid: attribution.yclid,
          ttclid: attribution.ttclid,
          rawParams: attribution.rawParams as Prisma.InputJsonValue | undefined,
          firstTouchAt: now,
          lastTouchAt: now,
        },
      });

      return created;
    });

    void dispatchWebhook(school.id, 'lead.created', {
      lead: {
        id: lead.id,
        source: lead.source,
        status: lead.status,
        createdAt: lead.createdAt.toISOString(),
      },
      attribution: {
        utmSource: attribution.utmSource,
        utmMedium: attribution.utmMedium,
        utmCampaign: attribution.utmCampaign,
        referrer: attribution.referrer,
        landingPage: attribution.landingPage,
      },
      // TODO: Decide whether explicitly opted-in contact fields should be included in future webhook payloads.
    }).catch(error => {
      log.warn({ err: error }, 'lead.created webhook dispatch failed');
    });

    res.status(201).json({ success: true, data: { id: lead.id, source: lead.source } });
  } catch (error) {
    log.error({ err: error }, 'create lead error');
    res.status(500).json({ success: false, error: 'Failed to create lead' });
  }
});

export default router;
