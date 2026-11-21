-- Add per-membership "book issued" flag (Книга button in schedule UI)
ALTER TABLE "GroupMembership" ADD COLUMN "bookIssued" BOOLEAN NOT NULL DEFAULT false;
