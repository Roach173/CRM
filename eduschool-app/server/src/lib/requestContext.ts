import { AsyncLocalStorage } from 'async_hooks';

interface RequestContext {
  schoolId?: number;
  userId?: number;
  role?: string;
  requestId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getContext(): RequestContext | undefined {
  return storage.getStore();
}

export function getSchoolId(): number | undefined {
  return storage.getStore()?.schoolId;
}

export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}
