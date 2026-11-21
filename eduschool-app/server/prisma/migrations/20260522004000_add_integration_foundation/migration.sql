-- CreateTable
CREATE TABLE "IntegrationConnection" (
    "id" SERIAL NOT NULL,
    "schoolId" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "displayName" TEXT,
    "credentialStatus" TEXT,
    "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "lastSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "connectedAt" TIMESTAMP(3),
    "disconnectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationSyncLog" (
    "id" SERIAL NOT NULL,
    "schoolId" INTEGER NOT NULL,
    "connectionId" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "externalId" TEXT,
    "message" TEXT,
    "metadata" JSONB,
    "occurredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntegrationSyncLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IntegrationConnection_schoolId_idx" ON "IntegrationConnection"("schoolId");

-- CreateIndex
CREATE INDEX "IntegrationConnection_provider_idx" ON "IntegrationConnection"("provider");

-- CreateIndex
CREATE INDEX "IntegrationConnection_status_idx" ON "IntegrationConnection"("status");

-- CreateIndex
CREATE INDEX "IntegrationConnection_enabled_idx" ON "IntegrationConnection"("enabled");

-- CreateIndex
CREATE INDEX "IntegrationConnection_updatedAt_idx" ON "IntegrationConnection"("updatedAt");

-- CreateIndex
CREATE INDEX "IntegrationSyncLog_schoolId_idx" ON "IntegrationSyncLog"("schoolId");

-- CreateIndex
CREATE INDEX "IntegrationSyncLog_connectionId_idx" ON "IntegrationSyncLog"("connectionId");

-- CreateIndex
CREATE INDEX "IntegrationSyncLog_provider_idx" ON "IntegrationSyncLog"("provider");

-- CreateIndex
CREATE INDEX "IntegrationSyncLog_eventType_idx" ON "IntegrationSyncLog"("eventType");

-- CreateIndex
CREATE INDEX "IntegrationSyncLog_status_idx" ON "IntegrationSyncLog"("status");

-- CreateIndex
CREATE INDEX "IntegrationSyncLog_createdAt_idx" ON "IntegrationSyncLog"("createdAt");

-- AddForeignKey
ALTER TABLE "IntegrationConnection" ADD CONSTRAINT "IntegrationConnection_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationSyncLog" ADD CONSTRAINT "IntegrationSyncLog_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationSyncLog" ADD CONSTRAINT "IntegrationSyncLog_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "IntegrationConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
