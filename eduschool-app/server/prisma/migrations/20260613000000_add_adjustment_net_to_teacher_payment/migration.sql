-- Add adjustmentNet to TeacherPayment to track the net salary adjustments
-- (bonuses, fines, advances) included at payment time for audit purposes.
ALTER TABLE "TeacherPayment" ADD COLUMN "adjustmentNet" DECIMAL(10, 2) NOT NULL DEFAULT 0;
