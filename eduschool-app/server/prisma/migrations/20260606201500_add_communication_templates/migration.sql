-- CreateTable
CREATE TABLE "CommunicationTemplate" (
    "id" SERIAL NOT NULL,
    "schoolId" INTEGER NOT NULL,
    "createdById" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'ANNOUNCEMENT',
    "priority" TEXT NOT NULL DEFAULT 'NORMAL',
    "channel" "CommunicationChannel" NOT NULL DEFAULT 'IN_APP',
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommunicationTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CommunicationTemplate_schoolId_isArchived_idx" ON "CommunicationTemplate"("schoolId", "isArchived");

-- CreateIndex
CREATE INDEX "CommunicationTemplate_schoolId_createdAt_idx" ON "CommunicationTemplate"("schoolId", "createdAt");

-- CreateIndex
CREATE INDEX "CommunicationTemplate_createdById_idx" ON "CommunicationTemplate"("createdById");

-- AddForeignKey
ALTER TABLE "CommunicationTemplate" ADD CONSTRAINT "CommunicationTemplate_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunicationTemplate" ADD CONSTRAINT "CommunicationTemplate_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
