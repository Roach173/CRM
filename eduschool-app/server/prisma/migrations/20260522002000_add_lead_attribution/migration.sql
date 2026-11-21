CREATE TABLE "LeadAttribution" (
  "id" SERIAL NOT NULL,
  "schoolId" INTEGER NOT NULL,
  "leadId" INTEGER NOT NULL,
  "touchType" TEXT,
  "utmSource" TEXT,
  "utmMedium" TEXT,
  "utmCampaign" TEXT,
  "utmContent" TEXT,
  "utmTerm" TEXT,
  "referrer" TEXT,
  "landingPage" TEXT,
  "gclid" TEXT,
  "fbclid" TEXT,
  "yclid" TEXT,
  "ttclid" TEXT,
  "rawParams" JSONB,
  "firstTouchAt" TIMESTAMP(3),
  "lastTouchAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LeadAttribution_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LeadAttribution_schoolId_idx" ON "LeadAttribution"("schoolId");
CREATE INDEX "LeadAttribution_leadId_idx" ON "LeadAttribution"("leadId");
CREATE INDEX "LeadAttribution_utmSource_idx" ON "LeadAttribution"("utmSource");
CREATE INDEX "LeadAttribution_utmMedium_idx" ON "LeadAttribution"("utmMedium");
CREATE INDEX "LeadAttribution_utmCampaign_idx" ON "LeadAttribution"("utmCampaign");
CREATE INDEX "LeadAttribution_createdAt_idx" ON "LeadAttribution"("createdAt");
CREATE INDEX "LeadAttribution_schoolId_createdAt_idx" ON "LeadAttribution"("schoolId", "createdAt");

ALTER TABLE "LeadAttribution" ADD CONSTRAINT "LeadAttribution_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LeadAttribution" ADD CONSTRAINT "LeadAttribution_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
