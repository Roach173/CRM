-- Phase 3: backend-enforced subscription state.
ALTER TYPE "SubscriptionStatus" RENAME VALUE 'TRIAL' TO 'TRIALING';
ALTER TYPE "SubscriptionStatus" ADD VALUE 'GRACE_PERIOD';

ALTER TABLE "Subscription" ALTER COLUMN "status" SET DEFAULT 'TRIALING';
ALTER TABLE "Subscription" ADD COLUMN "graceEndsAt" TIMESTAMP(3);

CREATE INDEX "Subscription_graceEndsAt_idx" ON "Subscription"("graceEndsAt");

UPDATE "Subscription" sub
SET "trialEndsAt" = s."createdAt" + INTERVAL '7 days'
FROM "School" s
WHERE sub."schoolId" = s."id"
  AND sub."status" = 'TRIALING'
  AND sub."trialEndsAt" IS NULL;

UPDATE "Subscription"
SET "graceEndsAt" = "trialEndsAt" + INTERVAL '3 days'
WHERE "graceEndsAt" IS NULL
  AND "trialEndsAt" IS NOT NULL;

INSERT INTO "Subscription" (
  "id",
  "schoolId",
  "plan",
  "status",
  "trialEndsAt",
  "graceEndsAt",
  "createdAt",
  "updatedAt"
)
SELECT
  'backfill_phase3_' || s."id",
  s."id",
  'TRIAL',
  'TRIALING',
  s."createdAt" + INTERVAL '7 days',
  s."createdAt" + INTERVAL '10 days',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "School" s
WHERE s."deletedAt" IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "Subscription" sub
    WHERE sub."schoolId" = s."id"
  );
