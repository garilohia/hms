import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReadQueue } from "@/src/lib/patient/read-queue";
import { isTransientReadError, PatientRequestError } from "@/src/lib/patient/read-errors";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("patient invalidation read queue", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("coalesces a burst without moving the first read's start", async () => {
    const read = vi.fn(async () => 1), onSuccess = vi.fn();
    const queue = createReadQueue({ read, onSuccess });
    queue.refresh();
    await vi.advanceTimersByTimeAsync(30);
    for (let n = 0; n < 100; n++) queue.refresh();
    await vi.advanceTimersByTimeAsync(10);
    expect(read).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledWith(1);
    queue.dispose();
  });

  it("never aborts a slow read for new pings and performs one trailing read", async () => {
    const first = deferred<number>();
    const read = vi.fn<(signal: AbortSignal) => Promise<number>>()
      .mockImplementationOnce(() => first.promise).mockResolvedValue(2);
    const onSuccess = vi.fn();
    const queue = createReadQueue({ read, onSuccess });
    queue.refresh();
    await vi.advanceTimersByTimeAsync(40);
    for (let n = 0; n < 100; n++) {
      queue.refresh();
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0][0].aborted).toBe(false);
    first.resolve(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(onSuccess).toHaveBeenCalledWith(1);
    await vi.advanceTimersByTimeAsync(40);
    expect(read).toHaveBeenCalledTimes(2);
    expect(onSuccess.mock.calls.map(([value]) => value)).toEqual([1, 2]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(read).toHaveBeenCalledTimes(2);
    queue.dispose();
  });

  it("recovers a failed final ping without any new ping", async () => {
    const error = new TypeError("Failed to fetch");
    const read = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(2);
    const onSuccess = vi.fn(), onError = vi.fn();
    const queue = createReadQueue({ read, onSuccess, onError });
    queue.refresh();
    await vi.advanceTimersByTimeAsync(40);
    expect(onError).toHaveBeenCalledWith(error, true);
    await vi.advanceTimersByTimeAsync(499);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
    expect(onSuccess).toHaveBeenCalledWith(2);
    queue.dispose();
  });

  it("backs off and exhausts its finite retry budget even when pings arrive", async () => {
    const error = new PatientRequestError("Temporarily unavailable", 503);
    const read = vi.fn().mockRejectedValue(error), onError = vi.fn();
    const queue = createReadQueue({ read, onSuccess: vi.fn(), onError });
    queue.refresh();
    await vi.advanceTimersByTimeAsync(40);
    queue.refresh();
    await vi.advanceTimersByTimeAsync(500);
    queue.refresh();
    await vi.advanceTimersByTimeAsync(1500);
    queue.refresh();
    await vi.advanceTimersByTimeAsync(4000);
    expect(read).toHaveBeenCalledTimes(4);
    expect(onError.mock.calls.map(([, retrying]) => retrying)).toEqual([true, true, true, false]);
    for (let n = 0; n < 100; n++) {
      expect(queue.refresh()).toBe(false);
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(read).toHaveBeenCalledTimes(4);
    queue.dispose();
  });

  it("resumes an exhausted transient cycle only after a genuine reconnect", async () => {
    const read = vi.fn().mockRejectedValue(new TypeError("Failed to fetch")), onSuccess = vi.fn();
    const queue = createReadQueue({ read, onSuccess, retryDelaysMs: [10] });
    queue.refresh();
    await vi.advanceTimersByTimeAsync(50);
    expect(read).toHaveBeenCalledTimes(2);
    expect(queue.setOnline(true)).toBe(false);
    expect(queue.refresh()).toBe(false);
    read.mockResolvedValue(6);
    queue.setOnline(false);
    expect(queue.setOnline(true)).toBe(true);
    await vi.advanceTimersByTimeAsync(40);
    expect(read).toHaveBeenCalledTimes(3);
    expect(onSuccess).toHaveBeenCalledWith(6);
    queue.dispose();
  });

  it.each([400, 401, 403, 404])("preserves HTTP %i and does not retry denied/invalid reads", async status => {
    const error = new PatientRequestError("You do not have access to this view.", status);
    const read = vi.fn().mockRejectedValue(error), onError = vi.fn();
    const queue = createReadQueue({ read, onSuccess: vi.fn(), onError });
    queue.refresh();
    await vi.advanceTimersByTimeAsync(40);
    queue.refresh();
    queue.setOnline(false);
    queue.setOnline(true);
    await vi.advanceTimersByTimeAsync(60000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(error, false);
    expect(error.status).toBe(status);
    queue.dispose();
  });

  it("pauses pending retries offline and reads once after reconnecting", async () => {
    const read = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValue(3);
    const onSuccess = vi.fn();
    const queue = createReadQueue({ read, onSuccess });
    queue.refresh();
    await vi.advanceTimersByTimeAsync(40);
    queue.setOnline(false);
    for (let n = 0; n < 10; n++) queue.refresh();
    await vi.advanceTimersByTimeAsync(60000);
    expect(read).toHaveBeenCalledTimes(1);
    queue.setOnline(true);
    await vi.advanceTimersByTimeAsync(40);
    expect(read).toHaveBeenCalledTimes(2);
    expect(onSuccess).toHaveBeenCalledWith(3);
    queue.dispose();
  });

  it("aborts offline work, ignores its late response and does not overlap the resumed read", async () => {
    const first = deferred<number>();
    const read = vi.fn<(signal: AbortSignal) => Promise<number>>()
      .mockImplementationOnce(() => first.promise).mockResolvedValue(4);
    const onSuccess = vi.fn();
    const queue = createReadQueue({ read, onSuccess });
    queue.refresh();
    await vi.advanceTimersByTimeAsync(40);
    queue.setOnline(false);
    expect(read.mock.calls[0][0].aborted).toBe(true);
    queue.setOnline(true);
    await vi.advanceTimersByTimeAsync(40);
    expect(read).toHaveBeenCalledTimes(1);
    first.resolve(1);
    await vi.advanceTimersByTimeAsync(40);
    expect(onSuccess.mock.calls.map(([value]) => value)).toEqual([4]);
    expect(read).toHaveBeenCalledTimes(2);
    queue.dispose();
  });

  it("times out a hung fetch and retries it without a broadcast", async () => {
    const read = vi.fn<(signal: AbortSignal) => Promise<number>>()
      .mockImplementationOnce(signal => new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      })).mockResolvedValue(5);
    const onSuccess = vi.fn(), onError = vi.fn();
    const queue = createReadQueue({ read, onSuccess, onError, timeoutMs: 100 });
    queue.refresh();
    await vi.advanceTimersByTimeAsync(140);
    expect(read.mock.calls[0][0].aborted).toBe(true);
    expect(onError.mock.calls[0][0]).toMatchObject({ name: "TimeoutError" });
    expect(onError.mock.calls[0][1]).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(onSuccess).toHaveBeenCalledWith(5);
    queue.dispose();
  });

  it("disposes delayed work without issuing a read", async () => {
    const read = vi.fn(), queue = createReadQueue({ read, onSuccess: vi.fn() });
    queue.refresh();
    queue.dispose();
    queue.refresh();
    queue.setOnline(true);
    await vi.advanceTimersByTimeAsync(60000);
    expect(read).not.toHaveBeenCalled();
  });

  it("aborts and ignores an old subject/query response after disposal", async () => {
    const old = deferred<number>(), oldSuccess = vi.fn(), oldError = vi.fn();
    const oldRead = vi.fn<(signal: AbortSignal) => Promise<number>>(() => old.promise);
    const oldQueue = createReadQueue({ read: oldRead, onSuccess: oldSuccess, onError: oldError });
    oldQueue.refresh();
    await vi.advanceTimersByTimeAsync(40);
    oldQueue.dispose();
    expect(vi.getTimerCount()).toBe(0);
    const newSuccess = vi.fn();
    const newQueue = createReadQueue({ read: async () => 9, onSuccess: newSuccess });
    newQueue.refresh();
    old.resolve(1);
    await vi.advanceTimersByTimeAsync(40);
    expect(oldRead.mock.calls[0][0].aborted).toBe(true);
    expect(oldSuccess).not.toHaveBeenCalled();
    expect(oldError).not.toHaveBeenCalled();
    expect(newSuccess).toHaveBeenCalledWith(9);
    newQueue.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lets a manual query wait for the aborted old read before starting its replacement", async () => {
    const old = deferred<number>(), onSuccess = vi.fn();
    const queue = createReadQueue({ read: () => old.promise, onSuccess });
    queue.refresh();
    await vi.advanceTimersByTimeAsync(40);
    const replacement = vi.fn(async () => 2);
    const changingQuery = (async () => { await queue.dispose(); return await replacement(); })();
    await vi.advanceTimersByTimeAsync(1000);
    expect(replacement).not.toHaveBeenCalled();
    old.resolve(1);
    await expect(changingQuery).resolves.toBe(2);
    expect(replacement).toHaveBeenCalledTimes(1);
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("does not retry malformed data or ordinary application exceptions", () => {
    expect(isTransientReadError(new Error("Invalid response schema"))).toBe(false);
    expect(isTransientReadError(new PatientRequestError("Too many requests", 429))).toBe(true);
    expect(isTransientReadError(new PatientRequestError("Timeout", 408))).toBe(true);
  });
});
