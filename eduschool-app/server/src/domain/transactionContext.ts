import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma';
import {
  createDomainCommandContext,
  DomainCommandEnvelope,
  DomainCommandHandler,
  DomainTransaction,
} from './commands';

export interface DomainTransactionOptions {
  isolationLevel?: Prisma.TransactionIsolationLevel;
  maxWait?: number;
  timeout?: number;
}

export interface DomainCommandHooks<TInput = unknown, TOutput = unknown> {
  beforeCommand?(envelope: DomainCommandEnvelope<TInput>): Promise<void> | void;
  afterCommand?(
    envelope: DomainCommandEnvelope<TInput>,
    result: TOutput
  ): Promise<void> | void;
}

export interface DomainTransactionProvider {
  $transaction<T>(
    fn: (tx: DomainTransaction) => Promise<T>,
    options?: DomainTransactionOptions
  ): Promise<T>;
}

export interface RunDomainCommandOptions<TInput = unknown, TOutput = unknown> {
  transactionProvider?: DomainTransactionProvider;
  transaction?: DomainTransactionOptions;
  hooks?: DomainCommandHooks<TInput, TOutput>;
}

export async function runDomainCommand<TInput, TOutput>(
  command: DomainCommandHandler<TInput, TOutput>,
  envelope: DomainCommandEnvelope<TInput>,
  options: RunDomainCommandOptions<TInput, TOutput> = {}
): Promise<TOutput> {
  const provider = options.transactionProvider ?? (prisma as unknown as DomainTransactionProvider);
  const commandEnvelope = { ...envelope, name: command.commandName };

  await options.hooks?.beforeCommand?.(commandEnvelope);

  const result = await provider.$transaction(async tx => {
    const context = createDomainCommandContext(commandEnvelope, tx);
    return command.execute(commandEnvelope.input, context);
  }, options.transaction);

  await options.hooks?.afterCommand?.(commandEnvelope, result);

  return result;
}
