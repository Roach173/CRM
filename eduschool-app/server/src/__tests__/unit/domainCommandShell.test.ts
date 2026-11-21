import {
  createDomainCommandContext,
  DomainCommandEnvelope,
  DomainCommandHandler,
  DomainTransaction,
  DomainTransactionProvider,
  runDomainCommand,
} from '../../domain';

function makeEnvelope(input: { value: number } = { value: 7 }): DomainCommandEnvelope<{ value: number }> {
  return {
    name: 'TestCommand',
    actor: {
      userId: 42,
      role: 'admin',
      actorType: 'user',
    },
    schoolId: 11,
    request: {
      requestId: 'req-123',
      correlationId: 'corr-456',
      idempotencyKey: 'idem-789',
      source: 'test',
      ip: '127.0.0.1',
      userAgent: 'jest',
    },
    input,
  };
}

function makeProvider(tx: DomainTransaction = { marker: 'tx' } as unknown as DomainTransaction) {
  const calls: Array<{ tx: DomainTransaction; options?: unknown }> = [];
  const provider: DomainTransactionProvider = {
    $transaction: jest.fn(async (fn, options) => {
      calls.push({ tx, options });
      return fn(tx);
    }),
  };

  return { provider, tx, calls };
}

describe('domain command shell', () => {
  it('creates command context with command name, actor, school, request, and tx', () => {
    const envelope = makeEnvelope();
    const tx = { marker: 'tx' } as unknown as DomainTransaction;

    const context = createDomainCommandContext(envelope, tx);

    expect(context).toMatchObject({
      commandName: 'TestCommand',
      actor: {
        userId: 42,
        role: 'admin',
        actorType: 'user',
      },
      schoolId: 11,
      request: {
        requestId: 'req-123',
        correlationId: 'corr-456',
        idempotencyKey: 'idem-789',
        source: 'test',
        ip: '127.0.0.1',
        userAgent: 'jest',
      },
    });
    expect(context.tx).toBe(tx);
  });

  it('runs command handlers inside the transaction provider', async () => {
    const { provider, tx } = makeProvider();
    const command: DomainCommandHandler<{ value: number }, number> = {
      commandName: 'TestCommand',
      execute: jest.fn(async (input, context) => {
        expect(context.tx).toBe(tx);
        return input.value + 1;
      }),
    };

    const result = await runDomainCommand(command, makeEnvelope(), {
      transactionProvider: provider,
      transaction: { timeout: 5000 },
    });

    expect(result).toBe(8);
    expect(provider.$transaction).toHaveBeenCalledTimes(1);
    expect(provider.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 5000 });
    expect(command.execute).toHaveBeenCalledTimes(1);
  });

  it('propagates command metadata to hooks and command handlers', async () => {
    const { provider } = makeProvider();
    const beforeCommand = jest.fn();
    const afterCommand = jest.fn();
    const seenContexts: unknown[] = [];
    const command: DomainCommandHandler<{ value: number }, { ok: true; requestId?: string }> = {
      commandName: 'CanonicalCommandName',
      execute: jest.fn(async (_input, context) => {
        seenContexts.push(context);
        return { ok: true as const, requestId: context.request.requestId };
      }),
    };

    const result = await runDomainCommand(command, makeEnvelope(), {
      transactionProvider: provider,
      hooks: { beforeCommand, afterCommand },
    });

    expect(result).toEqual({ ok: true, requestId: 'req-123' });
    expect(beforeCommand).toHaveBeenCalledWith(expect.objectContaining({
      name: 'CanonicalCommandName',
      schoolId: 11,
      actor: expect.objectContaining({ userId: 42 }),
      request: expect.objectContaining({ idempotencyKey: 'idem-789' }),
    }));
    expect(afterCommand).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'CanonicalCommandName' }),
      result
    );
    expect(seenContexts[0]).toMatchObject({
      commandName: 'CanonicalCommandName',
      request: expect.objectContaining({ requestId: 'req-123' }),
    });
  });

  it('does not add implicit business behavior around the command result', async () => {
    const { provider, calls } = makeProvider();
    const command: DomainCommandHandler<{ value: number }, { value: number }> = {
      commandName: 'EchoCommand',
      execute: jest.fn(async input => ({ value: input.value })),
    };

    const result = await runDomainCommand(command, makeEnvelope({ value: 99 }), {
      transactionProvider: provider,
    });

    expect(result).toEqual({ value: 99 });
    expect(calls).toHaveLength(1);
    expect(command.execute).toHaveBeenCalledWith(
      { value: 99 },
      expect.objectContaining({ commandName: 'EchoCommand', schoolId: 11 })
    );
  });
});
