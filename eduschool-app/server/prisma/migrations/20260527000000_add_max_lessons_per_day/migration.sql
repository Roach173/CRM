-- Add missing maxLessonsPerDay column to StaffProfile
ALTER TABLE "StaffProfile" ADD COLUMN IF NOT EXISTS "maxLessonsPerDay" INTEGER;
