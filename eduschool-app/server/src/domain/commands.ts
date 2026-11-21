import { Prisma } from '@prisma/client';

export type DomainTransaction = Prisma.TransactionClient;

export interface DomainActorContext {
  userId?: number;
  role?: string;
  actorType?: 'user' | 'system' | 'job' | 'script';
}

export interface DomainRequestMetadata {
  requestId?: string;
  correlationId?: string;
  idempotencyKey?: string;
  source?: 'route' | 'import' | 'job' | 'script' | 'test';
  ip?: string;
  userAgent?: string;
}

export interface DomainCommandEnvelope<TInput = unknown> {
  name: string;
  actor: DomainActorContext;
  schoolId: number;
  request: DomainRequestMetadata;
  input: TInput;
}

export interface DomainCommandContext {
  commandName: string;
  actor: DomainActorContext;
  schoolId: number;
  request: DomainRequestMetadata;
  tx: DomainTransaction;
}

export interface DomainCommandHandler<TInput = unknown, TOutput = unknown> {
  readonly commandName: string;
  execute(input: TInput, context: DomainCommandContext): Promise<TOutput>;
}

export function createDomainCommandContext(
  envelope: DomainCommandEnvelope,
  tx: DomainTransaction
): DomainCommandContext {
  return {
    commandName: envelope.name,
    actor: { ...envelope.actor },
    schoolId: envelope.schoolId,
    request: { ...envelope.request },
    tx,
  };
}
