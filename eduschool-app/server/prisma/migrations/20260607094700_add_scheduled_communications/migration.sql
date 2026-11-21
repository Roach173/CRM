-- AlterEnum
ALTER TYPE "CommunicationCampaignStatus" ADD VALUE 'SCHEDULED';

-- AlterTable
ALTER TABLE "CommunicationCampaign" ADD COLUMN     "scheduledAt" TIMESTAMP(3);
