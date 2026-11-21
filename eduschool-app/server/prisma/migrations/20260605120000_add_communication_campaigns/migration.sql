-- CreateEnum
CREATE TYPE "CommunicationChannel" AS ENUM ('IN_APP');

-- CreateEnum
CREATE TYPE "CommunicationCampaignStatus" AS ENUM ('DRAFT', 'SENDING', 'SENT', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CommunicationRecipientStatus" AS ENUM ('PENDING', 'SENT', 'SKIPPED', 'FAILED');

-- CreateEnum
CREATE TYPE "CommunicationTargetType" AS ENUM ('ROLES', 'USERS');

-- CreateTable
CREATE TABLE "CommunicationCampaign" (
    "id" SERIAL NOT NULL,
    "schoolId" INTEGER NOT NULL,
    "createdById" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "priority" TEXT NOT NULL,
    "channel" "CommunicationChannel" NOT NULL DEFAULT 'IN_APP',
    "status" "CommunicationCampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "targetType" "CommunicationTargetType" NOT NULL,
    "targetConfig" JSONB,
    "recipientsCount" INTEGER NOT NULL DEFAULT 0,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "CommunicationCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommunicationRecipient" (
    "id" SERIAL NOT NULL,
    "campaignId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "notificationId" INTEGER,
    "status" "CommunicationRecipientStatus" NOT NULL DEFAULT 'PENDING',
    "skippedReason" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommunicationRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CommunicationCampaign_schoolId_createdAt_idx" ON "CommunicationCampaign"("schoolId", "createdAt");

-- CreateIndex
CREATE INDEX "CommunicationCampaign_schoolId_status_idx" ON "CommunicationCampaign"("schoolId", "status");

-- CreateIndex
CREATE INDEX "CommunicationCampaign_createdById_idx" ON "CommunicationCampaign"("createdById");

-- CreateIndex
CREATE INDEX "CommunicationRecipient_campaignId_idx" ON "CommunicationRecipient"("campaignId");

-- CreateIndex
CREATE INDEX "CommunicationRecipient_userId_idx" ON "CommunicationRecipient"("userId");

-- CreateIndex
CREATE INDEX "CommunicationRecipient_notificationId_idx" ON "CommunicationRecipient"("notificationId");

-- CreateIndex
CREATE INDEX "CommunicationRecipient_status_idx" ON "CommunicationRecipient"("status");

-- CreateIndex
CREATE UNIQUE INDEX "CommunicationRecipient_campaignId_userId_key" ON "CommunicationRecipient"("campaignId", "userId");

-- AddForeignKey
ALTER TABLE "CommunicationCampaign" ADD CONSTRAINT "CommunicationCampaign_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunicationCampaign" ADD CONSTRAINT "CommunicationCampaign_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunicationRecipient" ADD CONSTRAINT "CommunicationRecipient_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "CommunicationCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunicationRecipient" ADD CONSTRAINT "CommunicationRecipient_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunicationRecipient" ADD CONSTRAINT "CommunicationRecipient_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE SET NULL ON UPDATE CASCADE;
