-- CreateTable
CREATE TABLE "StudentCalendarNote" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "schoolId" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StudentCalendarNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StudentCalendarNote_userId_idx" ON "StudentCalendarNote"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "StudentCalendarNote_userId_date_key" ON "StudentCalendarNote"("userId", "date");

-- AddForeignKey
ALTER TABLE "StudentCalendarNote" ADD CONSTRAINT "StudentCalendarNote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
