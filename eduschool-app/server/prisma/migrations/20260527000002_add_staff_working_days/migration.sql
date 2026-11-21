-- Add workingDays column to StaffProfile (was in baseline but never applied to DB)
ALTER TABLE "StaffProfile" ADD COLUMN IF NOT EXISTS "workingDays" INTEGER[] DEFAULT ARRAY[0, 1, 2, 3, 4, 5]::INTEGER[];
