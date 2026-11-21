import { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import prisma from './prisma';

/**
 * Subset of PrismaClient available inside a $transaction callback.
 * Matches what Prisma infers for the `tx` parameter automatically.
 */
export type PrismaTx = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

function db(tx?: PrismaTx): PrismaTx {
  return (tx as PrismaTx) ?? prisma;
}

/**
 * Thrown when a record does not exist OR belongs to a different tenant.
 *
 * Routes MUST return 404 on this error — never 403.
 * Returning 403 reveals that the record exists; 404 gives no information to attackers.
 */
export class TenantNotFoundError extends Error {
  constructor(resource: string) {
    super(`${resource} not found`);
    this.name = 'TenantNotFoundError';
  }
}

/** Type guard for route catch-blocks. */
export function isTenantNotFound(error: unknown): error is TenantNotFoundError {
  return error instanceof TenantNotFoundError;
}

/**
 * Returns true for Prisma P2025 "Record not found" errors.
 * Occurs when update/delete WHERE clause matches no rows — treat as 404.
 */
export function isPrismaNotFound(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2025'
  );
}

// ─── Single-record assertions ────────────────────────────────────────────────

/**
 * Asserts that a StudentProfile exists and belongs to the given school.
 * StudentProfile does not have a direct schoolId column — ownership is via User.schoolId.
 */
export async function assertStudentBelongsToSchool(
  studentProfileId: number,
  schoolId: number,
  tx?: PrismaTx,
): Promise<void> {
  const record = await db(tx).studentProfile.findFirst({
    where: { id: studentProfileId, user: { schoolId }, deletedAt: null },
    select: { id: true },
  });
  if (!record) throw new TenantNotFoundError('StudentProfile');
}

/**
 * Batch variant — asserts ALL ids belong to the school.
 * Used when a request body contains an array of studentProfileIds.
 */
export async function assertStudentsBelongToSchool(
  studentProfileIds: number[],
  schoolId: number,
  tx?: PrismaTx,
): Promise<void> {
  if (studentProfileIds.length === 0) return;
  const found = await db(tx).studentProfile.findMany({
    where: { id: { in: studentProfileIds }, user: { schoolId }, deletedAt: null },
    select: { id: true },
  });
  if (found.length !== studentProfileIds.length) {
    throw new TenantNotFoundError('StudentProfile');
  }
}

/**
 * Asserts that a StaffProfile exists and belongs to the given school.
 * Ownership is via User.schoolId (same pattern as StudentProfile).
 */
export async function assertStaffBelongsToSchool(
  staffProfileId: number,
  schoolId: number,
  tx?: PrismaTx,
): Promise<void> {
  const record = await db(tx).staffProfile.findFirst({
    where: { id: staffProfileId, user: { schoolId }, deletedAt: null },
    select: { id: true },
  });
  if (!record) throw new TenantNotFoundError('StaffProfile');
}

/**
 * Asserts that a LessonBlock exists and belongs to the given school.
 * LessonBlock has a direct schoolId column.
 */
export async function assertLessonBlockBelongsToSchool(
  blockId: number,
  schoolId: number,
  tx?: PrismaTx,
): Promise<void> {
  const record = await db(tx).lessonBlock.findFirst({
    where: { id: blockId, schoolId, deletedAt: null },
    select: { id: true },
  });
  if (!record) throw new TenantNotFoundError('LessonBlock');
}

/**
 * Asserts that a TeacherPayment record belongs to the given school.
 */
export async function assertTeacherPaymentBelongsToSchool(
  paymentId: number,
  schoolId: number,
  tx?: PrismaTx,
): Promise<void> {
  const record = await db(tx).teacherPayment.findFirst({
    where: { id: paymentId, schoolId },
    select: { id: true },
  });
  if (!record) throw new TenantNotFoundError('TeacherPayment');
}

/**
 * Asserts that a Webhook belongs to the given school.
 */
export async function assertWebhookBelongsToSchool(
  webhookId: number,
  schoolId: number,
  tx?: PrismaTx,
): Promise<void> {
  const record = await db(tx).webhook.findFirst({
    where: { id: webhookId, schoolId },
    select: { id: true },
  });
  if (!record) throw new TenantNotFoundError('Webhook');
}

/**
 * Asserts that an IntegrationConnection belongs to the given school.
 */
export async function assertIntegrationBelongsToSchool(
  integrationId: number,
  schoolId: number,
  tx?: PrismaTx,
): Promise<void> {
  const record = await db(tx).integrationConnection.findFirst({
    where: { id: integrationId, schoolId },
    select: { id: true },
  });
  if (!record) throw new TenantNotFoundError('IntegrationConnection');
}
