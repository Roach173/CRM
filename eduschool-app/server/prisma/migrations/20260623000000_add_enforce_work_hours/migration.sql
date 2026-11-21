-- Free-grid toggle for the schedule.
-- When false, work hours no longer bound the manageable grid and no slot is flagged
-- "вне сетки". Default true preserves the existing work-hours-bounded behaviour.
ALTER TABLE "School"
    ADD COLUMN "enforceWorkHours" BOOLEAN NOT NULL DEFAULT true;
