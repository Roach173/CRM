# ERP Write Boundary Policy

Status: PR 2 command shell and enforcement scaffold

## Core Rule

Business writes must pass through domain owners.

Prisma is the persistence adapter. Prisma is not the business write boundary.

No route, import handler, cron job, generic helper, or arbitrary script may directly mutate business entities unless it is explicitly approved as legacy debt or break-glass operational code.

## Official Write Path

All new business writes must follow this path:

`Route / Import / Job / Script -> Domain Command -> Transaction Context -> Domain Owner -> Prisma`

Routes, import handlers, jobs, and scripts may validate transport-level inputs, authenticate actors, and call domain commands. They do not own business writes, business invariants, or Prisma transactions.

Domain commands carry the command name, actor context, school id, request metadata, and transaction context. The transaction context is the standard owner of Prisma transactions and the future home for audit and idempotency hooks.

Domain owners are the approved place for business mutations. Current owner names include `IdentityDomain`, `MembershipDomain`, `SessionDomain`, `AttendanceDomain`, `CreditLedgerDomain`, `AccountingDomain`, `NotificationDomain`, and `SchoolPolicyDomain`.

## Approved Prisma Access Zones

Prisma client access is allowed in these zones:

- `server/src/domain/**`: future domain owners and command handlers.
- `server/src/infra/**`: infrastructure services that own operational tables only.
- `server/src/lib/prisma.ts`: the Prisma client adapter.
- `server/src/__tests__/**`: tests and fixtures.
- `server/prisma/migrations/**`: generated or reviewed database migrations.
- Files listed in `server/write-boundary-allowlist.json`: temporary legacy or explicit break-glass access.

Existing services are not permanently approved by folder. They are temporarily allowlisted until their mutations move behind domain owners.

## Not Approved By Default

These locations must not add new direct Prisma access:

- `server/src/routes/**`
- `server/src/routes/importexport.ts`
- `server/src/lib/**` generic helpers
- `server/src/middleware/**`
- `server/src/worker.ts`
- `server/src/index.ts`
- `server/src/scripts/**`
- `server/scripts/**`
- non-migration scripts under `server/prisma/**`

## What The Static Check Detects

The write-boundary check reports:

- importing the shared Prisma client from `src/lib/prisma`
- constructing `new PrismaClient`
- direct Prisma mutation calls: `create`, `createMany`, `update`, `updateMany`, `upsert`, `delete`, `deleteMany`
- nested relation mutation markers: `connect` and `disconnect`

Each reported file includes:

- file path
- reason
- whether it is allowed by the legacy allowlist
- whether it is a new violation

The check fails only when a forbidden file is not in an approved zone and not listed in the allowlist.

## Legacy Allowlist

`server/write-boundary-allowlist.json` is a measurable debt register. Adding a file to it is an explicit architecture exception and must include an owner and reason.

Allowlist entries should be removed in later PRs as code is moved behind domain owners. New business code should not be added to the allowlist unless it is a reviewed break-glass case.

The target before production is `legacy.length === 0`. The allowlist is temporary compatibility debt, not a permanent architecture layer.

## Migration Strategy

1. Keep PR 1 enforcement active and failing on new unapproved files.
2. Create domain owners one domain at a time.
3. Move route, import, cron, job, and script mutations into domain commands.
4. Remove allowlist entries as each file stops importing or constructing Prisma directly.
5. Tighten the policy after services are migrated so only domain and infra owners retain Prisma access.
6. Require every break-glass script to state owner, reason, scope, and rollback/check procedure.

## Target End State

Routes, import/export handlers, jobs, and scripts should orchestrate commands. They should not own invariants or mutate business tables directly.

Domain owners should be the only authority for business mutations.
