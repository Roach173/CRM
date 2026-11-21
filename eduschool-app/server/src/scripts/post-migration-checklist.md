# Post-migration checklist

Run after every `prisma migrate deploy` in staging or production.

## Steps

1. **Run consistency check**
   ```bash
   npm run db:check
   ```
   Exit code must be `0`. Any CRITICAL violation = rollback and investigate before proceeding.

2. **Verify active policy per school**
   Every school must have exactly one `SchoolSchedulePolicy` row with `effectiveTo = null`.
   If check 8 in `db:check` flagged a gap, run:
   ```bash
   npx tsx src/scripts/seed-policy-versions.ts
   ```

3. **Check orphan payments**
   If the migration touched `TeacherPayment` or `TeacherPaymentLesson`:
   ```bash
   npx tsx src/scripts/repair-orphan-payments.ts
   ```
   Review output in DRY_RUN mode first, then set `DRY_RUN=false` to fix.

4. **Smoke test billing invariants**
   - Create a test attendance record → confirm `LessonCreditLog` row is created.
   - Confirm `creditDeducted` is `true` on the resulting `Attendance` row.

5. **Confirm cron is running**
   Check PM2 / Railway logs for `extendAllBlockSessions` — should fire daily.
   If sessions for tomorrow are missing, trigger manually:
   ```bash
   curl -X POST http://localhost:3001/api/v1/schedule/extend-sessions \
     -H "Authorization: Bearer <admin-token>"
   ```

## What to do when `db:check` fails

| Severity | Action |
|----------|--------|
| CRITICAL | Stop. Do not proceed to production. Investigate root cause. File a bug. |
| WARNING  | Investigate. Most warnings indicate stale data from a prior edge case. Fix before next release if possible. |

## Rule

`db:check` must be green before any release that touches: sessions, attendance, credits, salary, or policy settings.
