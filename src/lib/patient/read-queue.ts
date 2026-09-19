import { isTransientReadError } from "./read-errors";

type ReadQueueOptions<T> = {
  read: (signal: AbortSignal) => Promise<T>;
  onSuccess: (value: T) => void;
  onError?: (error: unknown, retrying: boolean) => void;
  shouldRetry?: (error: unknown) => boolean;
  online?: boolean;
  debounceMs?: number;
  retryDelaysMs?: readonly number[];
  timeoutMs?: number;
};
type ReadFlight = { controller: AbortController; timedOut: boolean; timeout?: ReturnType<typeof setTimeout>; done: Promise<void>; finish: () => void };

/** Read-only invalidations: one active request, one trailing read, finite retry budget. */
export function createReadQueue<T>(options: ReadQueueOptions<T>) {
  const delays = options.retryDelaysMs ?? [500, 1500, 4000];
  const shouldRetry = options.shouldRetry ?? isTransientReadError;
  let online = options.online ?? true;
  let disposed = false;
  let terminal = false;
  let exhausted = false;
  let dirty = false;
  let retryIndex = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: ReadFlight | undefined;

  function schedule(delay: number) {
    if (disposed || terminal || exhausted || !online || active || timer !== undefined) return;
    timer = setTimeout(() => { timer = undefined; void run(); }, delay);
  }

  async function run() {
    if (disposed || terminal || exhausted || !online || active || !dirty) return;
    dirty = false;
    let finish: () => void = () => undefined;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const flight: ReadFlight = { controller: new AbortController(), timedOut: false, done, finish };
    active = flight;
    flight.timeout = setTimeout(() => {
      flight.timedOut = true;
      flight.controller.abort();
    }, options.timeoutMs ?? 15000);
    let retryDelay: number | undefined;
    try {
      const value = await options.read(flight.controller.signal);
      if (flight.timedOut) throw new DOMException("The view request timed out.", "TimeoutError");
      if (!disposed && online && !flight.controller.signal.aborted) {
        retryIndex = 0;
        options.onSuccess(value);
      }
    } catch (cause) {
      if (disposed || !online || (flight.controller.signal.aborted && !flight.timedOut)) return;
      const error = flight.timedOut ? new DOMException("The view request timed out.", "TimeoutError") : cause;
      terminal = !shouldRetry(error);
      if (!terminal && retryIndex < delays.length) {
        retryDelay = delays[retryIndex++];
        dirty = true;
      } else {
        // Pings must not reset a failed cycle into a request storm. Only reconnect/remount retries.
        dirty = false;
        exhausted = !terminal;
      }
      options.onError?.(error, retryDelay !== undefined);
    } finally {
      clearTimeout(flight.timeout);
      active = undefined;
      flight.finish();
      if (dirty) schedule(retryDelay ?? options.debounceMs ?? 40);
    }
  }

  return {
    refresh() {
      if (disposed || terminal || exhausted) return false;
      dirty = true;
      // Do not abort or postpone an active read/retry when more pings arrive.
      schedule(options.debounceMs ?? 40);
      return online;
    },
    setOnline(next: boolean) {
      if (disposed || next === online) return false;
      online = next;
      if (!next) {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        dirty = true;
        clearTimeout(active?.timeout);
        active?.controller.abort();
      } else {
        dirty = true;
        retryIndex = 0;
        exhausted = false;
        schedule(options.debounceMs ?? 40);
      }
      return next && !terminal;
    },
    dispose() {
      disposed = true;
      dirty = false;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      clearTimeout(active?.timeout);
      active?.controller.abort();
      // Manual query changes can await this before starting their replacement read.
      return active?.done ?? Promise.resolve();
    },
  };
}
