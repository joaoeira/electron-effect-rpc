import * as S from "effect/Schema";
import { Cause, Effect, Exit, Fiber, Result, Stream } from "effect";
import {
  isFunctionValue,
  isNumberValue,
  isRecord,
  isStringValue,
  toDiagnosticCause,
  type IpcEncodedValue,
} from "./boundary.ts";
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
  safelyCall,
  toDefectEnvelope,
  type RpcResponseEnvelope,
  type StreamFrame,
  type StreamEndFrame,
  type StreamErrorFrame,
  type StreamDefectFrame,
} from "./protocol.ts";
import {
  assertValidChannelPrefix,
  defaultChannelPrefix,
  type AnyEvent,
  type AnyMethod,
  type ChannelPrefix,
  type EventPublisherOptions,
  type EventPublisherStats,
  type Implementations,
  type IpcInvokeEvent,
  type IpcMainLike,
  type RpcEndpoint,
  type RpcEndpointOptions,
  type RpcEventPublisher,
  type WebContentsLike,
} from "./types.ts";

function readNamed<T, K extends keyof T>(record: T, key: K): T[K] {
  return record[key];
}

type RpcListener = (
  event: IpcInvokeEvent,
  payload: IpcEncodedValue,
) => Promise<RpcResponseEnvelope>;

function resolveChannelPrefix(prefix: ChannelPrefix | undefined): ChannelPrefix {
  return prefix ? assertValidChannelPrefix(prefix) : defaultChannelPrefix;
}

function isWebContentsLike<T>(value: T): value is T & WebContentsLike {
  return (
    isRecord(value) &&
    isNumberValue(value.id) &&
    isFunctionValue(value.isDestroyed) &&
    isFunctionValue(value.send) &&
    (value.once === undefined || isFunctionValue(value.once)) &&
    (value.removeListener === undefined || isFunctionValue(value.removeListener))
  );
}

function parseWebContentsLike<T>(value: T): WebContentsLike | null {
  return isWebContentsLike(value) ? value : null;
}

function extractSender<T>(event: T): WebContentsLike | null {
  if (!isRecord(event)) return null;
  return parseWebContentsLike(event.sender);
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
  const runPromiseExit = Effect.runPromiseExitWith(options.context);

  const implementationsByName = implementations;

  const methodNames = new Set(contract.methods.map((method) => method.name));

  for (const name in implementations) {
    if (!methodNames.has(name)) {
      throw new Error(`Implementation provided for unknown RPC method: ${name}`);
    }
  }

  function reportProtocolError<TResponse, TCause>(
    method: string,
    response: TResponse,
    cause: TCause,
  ): void {
    safelyCall(diagnostics?.onProtocolError, {
      method,
      response: toDiagnosticCause(response),
      cause: toDiagnosticCause(cause),
    });
  }

  const listeners = new Map<string, RpcListener>();

  for (const method of contract.methods) {
    const impl = readNamed(implementationsByName, method.name);
    if (!isFunctionValue(impl)) {
      throw new Error(`Missing implementation for RPC method: ${method.name}`);
    }

    const decodeInput = S.decodeUnknownSync(method.req);
    const encodeSuccess = S.encodeSync(method.res);
    const encodeFailure = isNoErrorSchema(method.err) ? null : S.encodeSync(method.err);

    const channel = `${channelPrefix.rpc}${method.name}`;

    listeners.set(
      channel,
      async function handleRpcRequest(
        event: IpcInvokeEvent,
        rawPayload: IpcEncodedValue,
      ): Promise<RpcResponseEnvelope> {
        let input: RpcInput<typeof method>;
        try {
          input = decodeInput(rawPayload);
        } catch (cause) {
          safelyCall(diagnostics?.onDecodeFailure, {
            scope: "rpc-request",
            name: method.name,
            payload: rawPayload,
            cause: toDiagnosticCause(cause),
          });

          return toDefectEnvelope(cause, `RPC ${method.name} request decode failed`);
        }

        let effect: Effect.Effect<RpcOutput<typeof method>, RpcError<typeof method>, R>;
        try {
          effect = impl(input, { sender: extractSender(event) });
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

        const failure = Cause.findErrorOption(exit.cause);
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

        const defect = Cause.findDefect(exit.cause);
        if (Result.isSuccess(defect)) {
          return toDefectEnvelope(defect.success, `RPC ${method.name} defect`);
        }

        return toDefectEnvelope(exit.cause, `RPC ${method.name} interrupted`);
      },
    );
  }

  // --- Stream handler setup ---

  type ActiveStreamEntry = {
    fiber: Fiber.Fiber<void, unknown> | null;
    senderId: number;
  };

  const activeStreams = new Map<string, ActiveStreamEntry>();
  const streamListeners = new Map<string, RpcListener>();
  const streamMethods = contract.streamMethods ?? [];
  const streamHandlerImpls = options.streamHandlers;

  const cancelChannel = `${channelPrefix.rpc}stream-cancel`;

  if (streamMethods.length > 0 && !streamHandlerImpls) {
    throw new Error("Contract defines stream methods but no streamHandlers were provided.");
  }

  if (
    streamMethods.length === 0 &&
    streamHandlerImpls &&
    Object.keys(streamHandlerImpls).length > 0
  ) {
    throw new Error("streamHandlers were provided but the contract defines no stream methods.");
  }

  if (streamMethods.length > 0 && streamHandlerImpls) {
    const streamMethodNames = new Set(streamMethods.map((m) => m.name));

    for (const name in streamHandlerImpls) {
      if (!streamMethodNames.has(name)) {
        throw new Error(`Stream implementation provided for unknown stream method: ${name}`);
      }
    }

    const runFork = Effect.runForkWith(options.context);

    for (const method of streamMethods) {
      const impl = readNamed(streamHandlerImpls, method.name);
      if (!isFunctionValue(impl)) {
        throw new Error(`Missing implementation for stream method: ${method.name}`);
      }

      const decodeInput = S.decodeUnknownSync(method.req);
      const encodeChunk = S.encodeSync(method.chunk);
      const encodeFailure = isNoErrorSchema(method.err) ? null : S.encodeSync(method.err);

      const channel = `${channelPrefix.rpc}stream/${method.name}`;

      streamListeners.set(
        channel,
        async function handleStreamRequest(
          event: IpcInvokeEvent,
          rawPayload: IpcEncodedValue,
        ): Promise<RpcResponseEnvelope> {
          if (!isRecord(rawPayload)) {
            return toDefectEnvelope("Stream request payload must be an object");
          }

          const streamId = rawPayload.streamId;
          const rawData = rawPayload.data;

          if (!isStringValue(streamId) || streamId.length === 0) {
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
              payload: toDiagnosticCause(rawData),
              cause: toDiagnosticCause(cause),
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
            handlerStream = impl(input, { sender });
          } catch (cause) {
            return toDefectEnvelope(cause, `Stream ${method.name} implementation threw`);
          }

          const buildTerminalFrame = (
            cause: Cause.Cause<unknown>,
          ): StreamEndFrame | StreamErrorFrame | StreamDefectFrame => {
            const failure = Cause.findErrorOption(cause);
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
                } catch (encodeCause) {
                  return {
                    type: "defect",
                    streamId,
                    message: `Stream ${method.name} failure encoding failed: ${formatUnknown(encodeCause)}`,
                  };
                }
              }
              return {
                type: "defect",
                streamId,
                message: `Stream ${method.name} returned a typed failure, but method declares NoError: ${formatUnknown(failure.value)}`,
              };
            }
            if (Cause.hasInterruptsOnly(cause)) {
              return { type: "end", streamId };
            }
            const defect = Cause.findDefect(cause);
            return {
              type: "defect",
              streamId,
              message: Result.isSuccess(defect)
                ? formatUnknown(defect.success)
                : "Stream failed unexpectedly",
            };
          };

          // Reserve entry BEFORE forking
          const entry: ActiveStreamEntry = {
            fiber: null,
            senderId: sender.id,
          };

          const onSenderDestroyed = () => {
            entry.fiber?.interruptUnsafe();
          };

          const streamEffect = handlerStream.pipe(
            Stream.mapEffect((chunk: StreamChunk<typeof method>) =>
              Effect.suspend(() => {
                // A destroyed renderer can never consume more chunks:
                // terminate the pipeline instead of draining the source.
                if (sender.isDestroyed()) {
                  return Effect.interrupt;
                }

                return Effect.try({
                  try: () =>
                    sender.send(sfChannel, { type: "data", streamId, payload: encodeChunk(chunk) }),
                  catch: () => undefined,
                }).pipe(Effect.ignore);
              }),
            ),
            Stream.runDrain,

            Effect.andThen(() => trySend({ type: "end", streamId })),

            Effect.catchCause((cause) =>
              sender.isDestroyed() ? Effect.void : trySend(buildTerminalFrame(cause)),
            ),

            Effect.ensuring(
              Effect.sync(() => {
                activeStreams.delete(streamId);
                if (sender.removeListener) {
                  sender.removeListener("destroyed", onSenderDestroyed);
                }
              }),
            ),
          );

          activeStreams.set(streamId, entry);

          if (sender.once) {
            sender.once("destroyed", onSenderDestroyed);
          }

          let fiber: Fiber.Fiber<void, unknown>;
          try {
            fiber = runFork(streamEffect);
          } catch (cause) {
            activeStreams.delete(streamId);
            if (sender.removeListener) {
              sender.removeListener("destroyed", onSenderDestroyed);
            }
            return toDefectEnvelope(cause, `Stream ${method.name} failed to start`);
          }
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
        ipc.handle(cancelChannel, (event: IpcInvokeEvent, rawPayload: IpcEncodedValue) => {
          if (!isRecord(rawPayload)) {
            return { cancelled: false };
          }

          const streamId = rawPayload.streamId;
          if (!isStringValue(streamId)) return { cancelled: false };

          const entry = activeStreams.get(streamId);
          if (!entry) return { cancelled: false };

          // Validate sender identity
          const sender = extractSender(event);
          if (!sender || sender.id !== entry.senderId) return { cancelled: false };

          // Interrupt the fiber
          if (entry.fiber) {
            entry.fiber.interruptUnsafe();
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
        entry.fiber.interruptUnsafe();
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
    let encoded: IpcEncodedValue;
    try {
      encoded = S.encodeSync(item.event.payload)(item.payload);
    } catch (cause) {
      dropped += 1;

      safelyCall(diagnostics?.onDecodeFailure, {
        scope: "event-payload",
        name: item.event.name,
        payload: toDiagnosticCause(item.payload),
        cause: toDiagnosticCause(cause),
      });

      safelyCall(diagnostics?.onDroppedEvent, {
        event: item.event.name,
        payload: toDiagnosticCause(item.payload),
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
        payload: toDiagnosticCause(item.payload),
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
          payload: toDiagnosticCause(item.payload),
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
          payload: toDiagnosticCause(item.payload),
          cause: toDiagnosticCause(cause),
        });

        safelyCall(diagnostics?.onDroppedEvent, {
          event: item.event.name,
          payload: toDiagnosticCause(item.payload),
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
      while (queue.length > 0) {
        if (!running || disposed) {
          break;
        }

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
          payload: toDiagnosticCause(evicted.payload),
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

  function stats(): EventPublisherStats {
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
