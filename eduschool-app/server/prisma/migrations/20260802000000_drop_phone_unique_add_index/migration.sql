-- phone is no longer unique per school: siblings commonly share one family
-- phone number. The login identifier for a colliding phone is instead an
-- auto-generated username (see students.ts POST /, e.g. "<phone>-02").
DROP INDEX IF EXISTS "User_schoolId_phone_key";
CREATE INDEX IF NOT EXISTS "User_schoolId_phone_idx" ON "User"("schoolId", "phone");
