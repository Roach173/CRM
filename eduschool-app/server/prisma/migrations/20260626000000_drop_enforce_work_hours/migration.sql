-- Remove the free-grid toggle. The schedule grid is always bounded by work hours;
-- slots outside hours are flagged "вне сетки" (the original, single behaviour).
ALTER TABLE "School" DROP COLUMN "enforceWorkHours";
