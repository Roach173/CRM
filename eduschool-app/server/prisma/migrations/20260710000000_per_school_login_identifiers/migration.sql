-- Per-school (per-tenant) login identifiers.
-- email is now optional; username is added; email/phone/username are unique
-- per school instead of globally, so the same person can hold a separate
-- account in each school. Postgres treats NULLs as distinct, so a school may
-- have many email-less / phone-less users without collision.

-- Normalize blank strings to NULL so empty placeholders don't collide on the
-- new unique indexes (NULLs are exempt, '' is not).
UPDATE "User" SET "email" = NULL WHERE "email" = '';
UPDATE "User" SET "phone" = NULL WHERE "phone" = '';

-- Drop the old global unique index on email.
DROP INDEX IF EXISTS "User_email_key";

-- AlterTable
ALTER TABLE "User" ADD COLUMN "username" TEXT,
ALTER COLUMN "email" DROP NOT NULL;

-- Per-school unique login identifiers.
CREATE UNIQUE INDEX "User_schoolId_email_key" ON "User"("schoolId", "email");
CREATE UNIQUE INDEX "User_schoolId_phone_key" ON "User"("schoolId", "phone");
CREATE UNIQUE INDEX "User_schoolId_username_key" ON "User"("schoolId", "username");
