-- CreateTable
CREATE TABLE "CalendarNote" (
    "id" SERIAL NOT NULL,
    "schoolId" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "content" TEXT NOT NULL,
    "authorId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CalendarNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CalendarNote_schoolId_idx" ON "CalendarNote"("schoolId");

-- CreateIndex
CREATE UNIQUE INDEX "CalendarNote_schoolId_date_key" ON "CalendarNote"("schoolId", "date");

-- AddForeignKey
ALTER TABLE "CalendarNote" ADD CONSTRAINT "CalendarNote_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;
