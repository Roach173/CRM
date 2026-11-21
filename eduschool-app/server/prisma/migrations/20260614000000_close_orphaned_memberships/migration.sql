-- Backfill: close GroupMembership rows that are still ACTIVE but point to a
-- soft-deleted StudentGroup. These accumulated because neither archiveGroup()
-- nor clear-all-data closed memberships when setting StudentGroup.deletedAt.
--
-- Enforces the invariant: status = 'ACTIVE' => studentGroup.deletedAt IS NULL.
-- Idempotent: re-running matches nothing once cleaned. leftAt is tied to the
-- group's actual deletion time where available.
UPDATE "GroupMembership" gm
SET "status"     = 'WITHDRAWN',
    "leftAt"     = COALESCE(sg."deletedAt", NOW()),
    "leftReason" = 'BACKFILL_ARCHIVED_GROUP'
FROM "StudentGroup" sg
WHERE gm."studentGroupId" = sg."id"
  AND sg."deletedAt" IS NOT NULL
  AND gm."status" = 'ACTIVE';
