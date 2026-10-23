import { ProviderError } from "../types/provider";

export interface ChatTimeouts {
  firstResponseMs: number;
  idleMs: number;
  totalMs: number;
}
export const DEFAULT_CHAT_TIMEOUTS: ChatTimeouts = {
  firstResponseMs: 120000,
  idleMs: 120000,
  totalMs: 600000,
};

export function cancellationReason(signal: AbortSignal): ProviderError {
  return signal.reason instanceof ProviderError
    ? signal.reason
    : new ProviderError({
        code: "aborted",
        message: "Client cancelled the request.",
      });
}

/** Race even adapters that fail to honor AbortSignal, without leaking listeners. */
export function abortable<T>(
  promise: PromiseLike<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    void Promise.resolve(promise).catch(() => undefined);
    return Promise.reject(cancellationReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const aborted = () => {
      cleanup();
      reject(cancellationReason(signal));
    };
    const cleanup = () => signal.removeEventListener("abort", aborted);
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export function createChatDeadline(
  parent?: AbortSignal,
  options: Partial<ChatTimeouts> = {},
) {
  const limits = { ...DEFAULT_CHAT_TIMEOUTS, ...options };
  const controller = new AbortController();
  let first: ReturnType<typeof setTimeout> | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let total: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const dispose = () => {
    disposed = true;
    clearTimeout(first);
    clearTimeout(idle);
    clearTimeout(total);
    parent?.removeEventListener("abort", cancel);
  };
  const fail = (kind: string) => {
    controller.abort(
      new ProviderError({
        code: "timeout",
        message: `Upstream ${kind} deadline exceeded.`,
        status: 504,
      }),
    );
    dispose();
  };
  const cancel = () => {
    controller.abort(cancellationReason(parent!));
    dispose();
  };
  if (parent?.aborted) cancel();
  else {
    parent?.addEventListener("abort", cancel, { once: true });
    first = setTimeout(() => fail("first response"), limits.firstResponseMs);
    total = setTimeout(() => fail("total"), limits.totalMs);
  }
  return {
    signal: controller.signal,
    dispose,
    progress: () => {
      if (disposed) return;
      clearTimeout(first);
      clearTimeout(idle);
      idle = setTimeout(() => fail("idle"), limits.idleMs);
    },
  };
}
