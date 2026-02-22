import * as S from "@effect/schema/Schema";
import { Cause, Effect, Exit, FiberId, Stream } from "effect";
import type * as FiberType from "effect/Fiber";
import * as Runtime from "effect/Runtime";
import type {
  AnyStreamMethod,
  RpcContract,
  RpcError,
  RpcEventPayload,
  RpcInput,
  RpcOutput,
  StreamChunk,
  StreamError,
  StreamInput,
} from "./contract.ts";
import { isNoErrorSchema } from "./contract.ts";
import {
  extractErrorTag,
  formatUnknown,
  isRecord,
  safelyCall,
  toDefectEnvelope,
  type RpcResponseEnvelope,
  type StreamFrame,
  type StreamEndFrame,
  type StreamErrorFrame,
  type StreamDefectFrame,
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
  type StreamImplementations,
  type WebContentsLike,
} from "./types.ts";

type RpcListener = (event: unknown, payload: unknown) => Promise<RpcResponseEnvelope>;

function resolveChannelPrefix(prefix: ChannelPrefix | undefined): ChannelPrefix {
  return prefix ?? defaultChannelPrefix;
}

function isWebContentsLike(value: unknown): value is WebContentsLike {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "number" &&
    typeof value.isDestroyed === "function" &&
    typeof value.send === "function"
  );
}

function extractSender(event: unknown): WebContentsLike | null {
  if (!isRecord(event)) return null;
  return isWebContentsLike(event.sender) ? event.sender : null;
}

function isImplementation<M extends AnyMethod, R>(
  value: unknown,
): value is (input: RpcInput<M>) => Effect.Effect<RpcOutput<M>, RpcError<M>, R> {
  return typeof value === "function";
}

function isStreamImplementation<M extends AnyStreamMethod, R>(
  value: unknown,
): value is (input: StreamInput<M>) => Stream.Stream<StreamChunk<M>, StreamError<M>, R> {
  return typeof value === "function";
}

export function createRpcEndpoint<
  const Methods extends ReadonlyArray<AnyMethod>,
  const Events extends ReadonlyArray<AnyEvent>,
  const StreamMethods extends ReadonlyArray<AnyStreamMethod> = readonly [],
  R = never,
>(
  contract: RpcContract<Methods, Events, StreamMethods>,
  ipc: IpcMainLike,
  implementations: Implementations<RpcContract<Methods, Events, StreamMethods>, R>,
  options: RpcEndpointOptions<RpcContract<Methods, Events, StreamMethods>, R>,
): RpcEndpoint {
  const channelPrefix = resolveChannelPrefix(options.channelPrefix);
  const diagnostics = options.diagnostics;
  const runPromiseExit = Runtime.runPromiseExit(options.runtime);

  const implementationsByName: Implementations<RpcContract<Methods, Events, StreamMethods>, R> &
    Record<string, unknown> = implementations;

  const methodNames = new Set(contract.methods.map((method) => method.name));

  for (const name in implementations) {
    if (!methodNames.has(name)) {
      throw new Error(`Implementation provided for unknown RPC method: ${name}`);
    }
  }

  function reportProtocolError(method: string, response: unknown, cause: unknown): void {
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
    const encodeFailure = isNoErrorSchema(method.err) ? null : S.encodeSync(method.err);

    const channel = `${channelPrefix.rpc}${method.name}`;

    listeners.set(
      channel,
      async function handleRpcRequest(
        _event: unknown,
        rawPayload: unknown,
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

        let effect: Effect.Effect<RpcOutput<typeof method>, RpcError<typeof method>, R>;
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
              `RPC ${method.name} returned a typed failure, but method declares NoError`,
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
      },
    );
  }

  // --- Stream handler setup ---

  type ActiveStreamEntry = {
    fiber: FiberType.RuntimeFiber<void, unknown> | null;
    senderId: number;
  };

  const activeStreams = new Map<string, ActiveStreamEntry>();
  const streamListeners = new Map<string, RpcListener>();
  const streamMethods = contract.streamMethods ?? [];
  const streamHandlerImpls:
    | (StreamImplementations<RpcContract<Methods, Events, StreamMethods>, R> &
        Record<string, unknown>)
    | undefined = options.streamHandlers;

  const cancelChannel = `${channelPrefix.rpc}stream-cancel`;

  if (streamMethods.length > 0 && !streamHandlerImpls) {
    throw new Error("Contract defines stream methods but no streamHandlers were provided.");
  }

  if (streamMethods.length > 0 && streamHandlerImpls) {
    const streamMethodNames = new Set(streamMethods.map((m) => m.name));

    for (const name in streamHandlerImpls) {
      if (!streamMethodNames.has(name)) {
        throw new Error(`Stream implementation provided for unknown stream method: ${name}`);
      }
    }

    const runFork = Runtime.runFork(options.runtime);

    for (const method of streamMethods) {
      const impl = streamHandlerImpls[method.name];
      if (!isStreamImplementation<typeof method, R>(impl)) {
        throw new Error(`Missing implementation for stream method: ${method.name}`);
      }

      const decodeInput = S.decodeUnknownSync(method.req);
      const encodeChunk = S.encodeSync(method.chunk);
      const encodeFailure = isNoErrorSchema(method.err) ? null : S.encodeSync(method.err);

      const channel = `${channelPrefix.rpc}stream/${method.name}`;

      streamListeners.set(
        channel,
        async function handleStreamRequest(
          event: unknown,
          rawPayload: unknown,
        ): Promise<RpcResponseEnvelope> {
          if (!isRecord(rawPayload)) {
            return toDefectEnvelope("Stream request payload must be an object");
          }

          const streamId = rawPayload.streamId;
          const rawData = rawPayload.data;

          if (typeof streamId !== "string" || streamId.length === 0) {
            return toDefectEnvelope("Invalid streamId");
          }

          if (activeStreams.has(streamId)) {
            return toDefectEnvelope("Duplicate streamId");
          }

          const sender = extractSender(event);
          if (!sender) {
            return toDefectEnvelope("Stream handler requires sender with webContents");
          }

          let input: StreamInput<typeof method>;
          try {
            input = decodeInput(rawData);
          } catch (cause) {
            const decodeCtx: import("./types.ts").DecodeFailureContext = {
              scope: "stream-request",
              name: method.name,
              payload: rawData,
              cause,
            };
            safelyCall(diagnostics?.onDecodeFailure, decodeCtx);
            return toDefectEnvelope(cause, `Stream ${method.name} request decode failed`);
          }

          const sfChannel = `${channelPrefix.rpc}sf`;

          const trySend = (frame: StreamFrame): Effect.Effect<void> =>
            Effect.try({
              try: () => {
                if (!sender.isDestroyed()) {
                  sender.send(sfChannel, frame);
                }
              },
              catch: () => undefined,
            }).pipe(Effect.ignore);

          let handlerStream: Stream.Stream<
            StreamChunk<typeof method>,
            StreamError<typeof method>,
            R
          >;
          try {
            handlerStream = impl(input);
          } catch (cause) {
            return toDefectEnvelope(cause, `Stream ${method.name} implementation threw`);
          }

          const buildTerminalFrame = (
            cause: Cause.Cause<unknown>,
          ): StreamEndFrame | StreamErrorFrame | StreamDefectFrame => {
            const failure = Cause.failureOption(cause);
            if (failure._tag === "Some") {
              if (encodeFailure) {
                try {
                  return {
                    type: "error",
                    streamId,
                    error: {
                      tag: extractErrorTag(failure.value),
                      data: encodeFailure(failure.value),
                    },
                  };
                } catch {
                  // encoding failed, fall through to defect
                }
              }
              return { type: "defect", streamId, message: formatUnknown(failure.value) };
            }
            if (Cause.isInterruptedOnly(cause)) {
              return { type: "end", streamId };
            }
            const defect = Cause.dieOption(cause);
            return {
              type: "defect",
              streamId,
              message:
                defect._tag === "Some" ? formatUnknown(defect.value) : "Stream failed unexpectedly",
            };
          };

          const streamEffect = handlerStream.pipe(
            Stream.mapEffect((chunk: StreamChunk<typeof method>) =>
              Effect.try({
                try: () => {
                  if (sender.isDestroyed()) return;
                  sender.send(sfChannel, { type: "data", streamId, payload: encodeChunk(chunk) });
                },
                catch: () => undefined,
              }).pipe(Effect.ignore),
            ),
            Stream.runDrain,

            Effect.andThen(() => trySend({ type: "end", streamId })),

            Effect.catchAllCause((cause) =>
              sender.isDestroyed() ? Effect.void : trySend(buildTerminalFrame(cause)),
            ),

            Effect.ensuring(
              Effect.sync(() => {
                activeStreams.delete(streamId);
              }),
            ),
          );

          // Reserve entry BEFORE forking
          const entry: ActiveStreamEntry = {
            fiber: null,
            senderId: sender.id,
          };
          activeStreams.set(streamId, entry);

          const fiber = runFork(streamEffect);
          entry.fiber = fiber;

          const response: RpcResponseEnvelope = {
            type: "success",
            data: { type: "stream_started" },
          };
          return response;
        },
      );
    }
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

    const registeredChannels: string[] = [];

    try {
      for (const [channel, listener] of listeners) {
        ipc.handle(channel, listener);
        registeredChannels.push(channel);
      }

      // Register stream handlers
      for (const [channel, listener] of streamListeners) {
        ipc.handle(channel, listener);
        registeredChannels.push(channel);
      }

      // Register cancel handler if we have stream methods
      if (streamMethods.length > 0) {
        ipc.handle(cancelChannel, (event: unknown, rawPayload: unknown) => {
          if (!isRecord(rawPayload)) {
            return { cancelled: false };
          }

          const streamId = rawPayload.streamId;
          if (typeof streamId !== "string") return { cancelled: false };

          const entry = activeStreams.get(streamId);
          if (!entry) return { cancelled: false };

          // Validate sender identity
          const sender = extractSender(event);
          if (!sender || sender.id !== entry.senderId) return { cancelled: false };

          // Interrupt the fiber
          if (entry.fiber) {
            entry.fiber.unsafeInterruptAsFork(FiberId.none);
          }

          return { cancelled: true };
        });
        registeredChannels.push(cancelChannel);
      }
    } catch (cause) {
      for (const channel of registeredChannels) {
        try {
          ipc.removeHandler(channel);
        } catch {
          // Best-effort rollback: avoid leaving partial registration behind.
        }
      }

      throw cause;
    }

    running = true;
  }

  function stop(): void {
    if (!running) {
      return;
    }

    // Interrupt all active stream fibers first
    for (const entry of activeStreams.values()) {
      if (entry.fiber) {
        entry.fiber.unsafeInterruptAsFork(FiberId.none);
      }
    }
    activeStreams.clear();

    let firstError: unknown;

    for (const channel of listeners.keys()) {
      try {
        ipc.removeHandler(channel);
      } catch (cause) {
        firstError ??= cause;
      }
    }

    for (const channel of streamListeners.keys()) {
      try {
        ipc.removeHandler(channel);
      } catch (cause) {
        firstError ??= cause;
      }
    }

    if (streamMethods.length > 0) {
      try {
        ipc.removeHandler(cancelChannel);
      } catch (cause) {
        firstError ??= cause;
      }
    }

    running = false;

    if (firstError !== undefined) {
      throw firstError;
    }
  }

  function dispose(): void {
    if (disposed) {
      return;
    }

    let stopError: unknown;

    try {
      stop();
    } catch (cause) {
      stopError = cause;
    }

    disposed = true;

    if (stopError !== undefined) {
      throw stopError;
    }
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
  const Events extends ReadonlyArray<AnyEvent>,
  const StreamMethods extends ReadonlyArray<AnyStreamMethod> = readonly [],
>(
  _contract: RpcContract<Methods, Events, StreamMethods>,
  options: EventPublisherOptions,
): RpcEventPublisher<RpcContract<Methods, Events, StreamMethods>> {
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

    const windows = options.getWindows();
    if (windows.length === 0) {
      dropped += 1;

      safelyCall(diagnostics?.onDroppedEvent, {
        event: item.event.name,
        payload: item.payload,
        reason: "window_unavailable",
        queued: queue.length,
        dropped,
      });

      return;
    }

    const channel = `${channelPrefix.event}${item.event.name}`;
    for (const window of windows) {
      if (window.isDestroyed()) {
        dropped += 1;

        safelyCall(diagnostics?.onDroppedEvent, {
          event: item.event.name,
          payload: item.payload,
          reason: "window_unavailable",
          queued: queue.length,
          dropped,
        });

        continue;
      }

      try {
        window.webContents.send(channel, encoded);
      } catch (cause) {
        dropped += 1;

        safelyCall(diagnostics?.onDispatchFailure, {
          event: item.event.name,
          payload: item.payload,
          cause,
        });

        safelyCall(diagnostics?.onDroppedEvent, {
          event: item.event.name,
          payload: item.payload,
          reason: "dispatch_failed",
          queued: queue.length,
          dropped,
        });
      }
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
    payload: RpcEventPayload<E>,
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
