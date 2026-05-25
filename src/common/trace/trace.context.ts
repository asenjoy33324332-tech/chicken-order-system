import { AsyncLocalStorage } from 'async_hooks';

export interface TraceContext {
  traceId: string;
  orderId?: string;
  storeId?: string;
  workerId?: string;
}

export const traceStorage = new AsyncLocalStorage<TraceContext>();

export function getTraceContext(): Partial<TraceContext> {
  return traceStorage.getStore() ?? {};
}

export function runWithTrace<T>(ctx: TraceContext, fn: () => T): T {
  return traceStorage.run(ctx, fn);
}
