-- Phase 5: Database Invariants
--
-- IMPORTANT: Run scripts/precheck-db-invariants.ts BEFORE this migration.
-- If precheck exits with code 1, do NOT apply until all violations are repaired.
--
-- Adds:
--   5.2  CHECK constraints  — reject invalid amounts at DB level
--   5.3  Partial unique indexes — one DEBIT per attendance, one PENDING enrollment per student/group
--   5.4  Composite tenant safety indexes — (schoolId, id) on key financial tables

-- ─── 5.2: CHECK constraints ──────────────────────────────────────────────────

-- StudentProfile.credits cannot be negative
ALTER TABLE "StudentProfile"
  ADD CONSTRAINT "StudentProfile_credits_nonnegative"
  CHECK (credits >= 0);

-- StaffProfile.salaryRate cannot be negative (NULL is allowed — rate not yet assigned)
ALTER TABLE "StaffProfile"
  ADD CONSTRAINT "StaffProfile_salaryRate_nonnegative"
  CHECK ("salaryRate" IS NULL OR "salaryRate" >= 0);

-- Payment.amount must be strictly positive
ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_amount_positive"
  CHECK (amount > 0);

-- StudentPayment.amount must be strictly positive
ALTER TABLE "StudentPayment"
  ADD CONSTRAINT "StudentPayment_amount_positive"
  CHECK (amount > 0);

-- TeacherPayment.amount must be strictly positive
ALTER TABLE "TeacherPayment"
  ADD CONSTRAINT "TeacherPayment_amount_positive"
  CHECK (amount > 0);

-- PaymentRefund.amount must be strictly positive
ALTER TABLE "PaymentRefund"
  ADD CONSTRAINT "PaymentRefund_amount_positive"
  CHECK (amount > 0);

-- NOTE: SalaryAdjustment.amount NOT constrained — FINE adjustments can be negative.
-- NOTE: LessonCreditLog.amount NOT constrained — DEBIT/REFUND entries have opposing signs.

-- ─── 5.3: Partial unique indexes ─────────────────────────────────────────────

-- One DEBIT credit log per attendance (prevents double credit deduction)
-- Only enforced when attendanceId is set and type = DEBIT
CREATE UNIQUE INDEX "LessonCreditLog_debit_per_attendance"
  ON "LessonCreditLog" ("attendanceId")
  WHERE "attendanceId" IS NOT NULL AND "type" = 'DEBIT';

-- One PENDING enrollment per student per group (prevents duplicate waitlist)
-- Only enforced when studentGroupId is set and status = PENDING
CREATE UNIQUE INDEX "EnrollmentRequest_one_pending_per_student_group"
  ON "EnrollmentRequest" ("studentProfileId", "studentGroupId")
  WHERE "studentGroupId" IS NOT NULL AND "status" = 'PENDING';

-- NOTE: TeacherPaymentLesson.lessonSessionId already has @unique from schema — no duplicate needed.
-- NOTE: IdempotencyKey already has UNIQUE on (schoolId, scopeType, actorId, endpoint, key) — no duplicate needed.

-- ─── 5.4: Composite tenant safety indexes ────────────────────────────────────
--
-- These enable efficient tenant-scoped range scans and support cross-tenant
-- audit queries in O(log n) without full table scans at 50k+ students.

CREATE INDEX IF NOT EXISTS "Attendance_schoolId_id_idx"
  ON "Attendance" ("schoolId", "id");

CREATE INDEX IF NOT EXISTS "SessionStudent_schoolId_id_idx"
  ON "SessionStudent" ("schoolId", "id");

CREATE INDEX IF NOT EXISTS "Payment_schoolId_id_idx"
  ON "Payment" ("schoolId", "id");

CREATE INDEX IF NOT EXISTS "TeacherPayment_schoolId_id_idx"
  ON "TeacherPayment" ("schoolId", "id");

CREATE INDEX IF NOT EXISTS "LessonCreditLog_schoolId_id_idx"
  ON "LessonCreditLog" ("schoolId", "id");

CREATE INDEX IF NOT EXISTS "Invoice_schoolId_id_idx"
  ON "Invoice" ("schoolId", "id");

CREATE INDEX IF NOT EXISTS "PaymentRefund_schoolId_id_idx"
  ON "PaymentRefund" ("schoolId", "id");
