import * as S from "@effect/schema/Schema";
import { Cause, Effect, Exit } from "effect";
import * as Runtime from "effect/Runtime";
import type {
  RpcContract,
  RpcError,
  RpcEventPayload,
  RpcInput,
  RpcOutput,
} from "./contract.ts";
import { isNoErrorSchema } from "./contract.ts";
import {
  extractErrorTag,
  safelyCall,
  toDefectEnvelope,
  type RpcResponseEnvelope,
} from "./protocol.ts";
import {
  defaultChannelPrefix,
  type AnyEvent,
  type AnyMethod,
  type ChannelPrefix,
  type EventPublisherOptions,
  type Implementations,
  type IpcMainLike,
  type RpcEndpoint,
  type RpcEndpointOptions,
  type RpcEventPublisher,
} from "./types.ts";

type RpcListener = (
  event: unknown,
  payload: unknown
) => Promise<RpcResponseEnvelope>;

function resolveChannelPrefix(prefix: ChannelPrefix | undefined): ChannelPrefix {
  return prefix ?? defaultChannelPrefix;
}

function isImplementation<M extends AnyMethod, R>(
  value: unknown
): value is (
  input: RpcInput<M>
) => Effect.Effect<RpcOutput<M>, RpcError<M>, R> {
  return typeof value === "function";
}

export function createRpcEndpoint<
  const Methods extends ReadonlyArray<AnyMethod>,
  const Events extends ReadonlyArray<AnyEvent>,
  R = never
>(
  contract: RpcContract<Methods, Events>,
  ipc: IpcMainLike,
  implementations: Implementations<RpcContract<Methods, Events>, R>,
  options: RpcEndpointOptions<R>
): RpcEndpoint {
  const channelPrefix = resolveChannelPrefix(options.channelPrefix);
  const diagnostics = options.diagnostics;
  const runPromiseExit = Runtime.runPromiseExit(options.runtime);

  const implementationsByName: Implementations<RpcContract<Methods, Events>, R> &
    Record<string, unknown> = implementations;

  const methodNames = new Set(contract.methods.map((method) => method.name));

  for (const name in implementations) {
    if (!methodNames.has(name)) {
      throw new Error(`Implementation provided for unknown RPC method: ${name}`);
    }
  }

  function reportProtocolError(
    method: string,
    response: unknown,
    cause: unknown
  ): void {
    safelyCall(diagnostics?.onProtocolError, {
      method,
      response,
      cause,
    });
  }

  const listeners = new Map<string, RpcListener>();

  for (const method of contract.methods) {
    const impl = implementationsByName[method.name];
    if (!isImplementation<typeof method, R>(impl)) {
      throw new Error(`Missing implementation for RPC method: ${method.name}`);
    }

    const decodeInput = S.decodeUnknownSync(method.req);
    const encodeSuccess = S.encodeSync(method.res);
    const encodeFailure = isNoErrorSchema(method.err)
      ? null
      : S.encodeSync(method.err);

    const channel = `${channelPrefix.rpc}${method.name}`;

    listeners.set(
      channel,
      async function handleRpcRequest(
        _event: unknown,
        rawPayload: unknown
      ): Promise<RpcResponseEnvelope> {
        let input: RpcInput<typeof method>;
        try {
          input = decodeInput(rawPayload);
        } catch (cause) {
          safelyCall(diagnostics?.onDecodeFailure, {
            scope: "rpc-request",
            name: method.name,
            payload: rawPayload,
            cause,
          });

          return toDefectEnvelope(cause, `RPC ${method.name} request decode failed`);
        }

        let effect: Effect.Effect<
          RpcOutput<typeof method>,
          RpcError<typeof method>,
          R
        >;
        try {
          effect = impl(input);
        } catch (cause) {
          return toDefectEnvelope(cause, `RPC ${method.name} implementation threw`);
        }

        const exit = await runPromiseExit(effect);

        if (Exit.isSuccess(exit)) {
          try {
            return {
              type: "success",
              data: encodeSuccess(exit.value),
            };
          } catch (cause) {
            reportProtocolError(method.name, exit.value, cause);
            return toDefectEnvelope(cause, `RPC ${method.name} success encoding failed`);
          }
        }

        const failure = Cause.failureOption(exit.cause);
        if (failure._tag === "Some") {
          if (!encodeFailure) {
            return toDefectEnvelope(
              failure.value,
              `RPC ${method.name} returned a typed failure, but method declares NoError`
            );
          }

          try {
            return {
              type: "failure",
              error: {
                tag: extractErrorTag(failure.value),
                data: encodeFailure(failure.value),
              },
            };
          } catch (cause) {
            reportProtocolError(method.name, failure.value, cause);
            return toDefectEnvelope(cause, `RPC ${method.name} failure encoding failed`);
          }
        }

        const defect = Cause.dieOption(exit.cause);
        if (defect._tag === "Some") {
          return toDefectEnvelope(defect.value, `RPC ${method.name} defect`);
        }

        return toDefectEnvelope(exit.cause, `RPC ${method.name} interrupted`);
      }
    );
  }

  let running = false;
  let disposed = false;

  function start(): void {
    if (disposed) {
      throw new Error("RPC endpoint has already been disposed.");
    }

    if (running) {
      return;
    }

    for (const [channel, listener] of listeners) {
      ipc.handle(channel, listener);
    }

    running = true;
  }

  function stop(): void {
    if (!running) {
      return;
    }

    for (const channel of listeners.keys()) {
      ipc.removeHandler(channel);
    }

    running = false;
  }

  function dispose(): void {
    if (disposed) {
      return;
    }

    stop();
    disposed = true;
  }

  function isRunning(): boolean {
    return running;
  }

  return {
    start,
    stop,
    dispose,
    isRunning,
  };
}

type QueueItem<E extends AnyEvent> = {
  readonly event: E;
  readonly payload: RpcEventPayload<E>;
};

function clampQueueSize(maxQueueSize: number | undefined): number {
  if (maxQueueSize === undefined) {
    return 1000;
  }

  if (!Number.isFinite(maxQueueSize) || maxQueueSize < 1) {
    throw new Error("Event publisher maxQueueSize must be a positive finite number.");
  }

  return Math.floor(maxQueueSize);
}

export function createEventPublisher<
  const Methods extends ReadonlyArray<AnyMethod>,
  const Events extends ReadonlyArray<AnyEvent>
>(
  _contract: RpcContract<Methods, Events>,
  options: EventPublisherOptions
): RpcEventPublisher<RpcContract<Methods, Events>> {
  const channelPrefix = resolveChannelPrefix(options.channelPrefix);
  const diagnostics = options.diagnostics;
  const maxQueueSize = clampQueueSize(options.maxQueueSize);

  const queue: Array<QueueItem<Events[number]>> = [];

  let dropped = 0;
  let running = false;
  let disposed = false;
  let draining = false;
  let drainScheduled = false;

  function scheduleDrain(): void {
    if (!running || disposed || draining || drainScheduled) {
      return;
    }

    drainScheduled = true;
    queueMicrotask(() => {
      drainScheduled = false;
      drain();
    });
  }

  function dispatch(item: QueueItem<Events[number]>): void {
    let encoded: unknown;
    try {
      encoded = S.encodeSync(item.event.payload)(item.payload);
    } catch (cause) {
      dropped += 1;

      safelyCall(diagnostics?.onDecodeFailure, {
        scope: "event-payload",
        name: item.event.name,
        payload: item.payload,
        cause,
      });

      safelyCall(diagnostics?.onDroppedEvent, {
        event: item.event.name,
        payload: item.payload,
        reason: "encoding_failed",
        queued: queue.length,
        dropped,
      });

      return;
    }

    const window = options.getWindow();
    if (!window || window.isDestroyed()) {
      return;
    }

    try {
      window.webContents.send(`${channelPrefix.event}${item.event.name}`, encoded);
    } catch (cause) {
      safelyCall(diagnostics?.onDispatchFailure, {
        event: item.event.name,
        payload: item.payload,
        cause,
      });
    }
  }

  function drain(): void {
    if (!running || disposed || draining) {
      return;
    }

    draining = true;

    try {
      while (running && !disposed && queue.length > 0) {
        const next = queue.shift();
        if (!next) {
          continue;
        }

        dispatch(next);
      }
    } finally {
      draining = false;

      if (running && !disposed && queue.length > 0) {
        scheduleDrain();
      }
    }
  }

  function enqueue(item: QueueItem<Events[number]>): void {
    if (queue.length >= maxQueueSize) {
      const evicted = queue.shift();
      dropped += 1;

      if (evicted) {
        safelyCall(diagnostics?.onDroppedEvent, {
          event: evicted.event.name,
          payload: evicted.payload,
          reason: "queue_full",
          queued: queue.length,
          dropped,
        });
      }
    }

    queue.push(item);
    scheduleDrain();
  }

  function publish<E extends Events[number]>(
    event: E,
    payload: RpcEventPayload<E>
  ): Effect.Effect<void, never> {
    return Effect.sync(() => {
      if (disposed) {
        return;
      }

      enqueue({ event, payload });
    });
  }

  function start(): void {
    if (disposed) {
      throw new Error("Event publisher has already been disposed.");
    }

    if (running) {
      return;
    }

    running = true;
    scheduleDrain();
  }

  function stop(): void {
    if (!running) {
      return;
    }

    running = false;
  }

  function dispose(): void {
    if (disposed) {
      return;
    }

    stop();
    queue.length = 0;
    disposed = true;
  }

  function isRunning(): boolean {
    return running;
  }

  function stats(): { readonly queued: number; readonly dropped: number } {
    return {
      queued: queue.length,
      dropped,
    };
  }

  return {
    publish,
    start,
    stop,
    dispose,
    isRunning,
    stats,
  };
}
