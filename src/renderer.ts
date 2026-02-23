import * as S from "@effect/schema/Schema";
import { Cause, Effect, Exit, Stream } from "effect";
import {
  exitSchemaFor,
  isNoErrorSchema,
  type AnyStreamMethod,
  type RpcContract,
  type RpcEventPayload,
  type RpcInput,
  type RpcOutput,
  type StreamChunk,
  type StreamInput,
} from "./contract.ts";
import {
  extractStreamIdFromRaw,
  formatUnknown,
  isRecord,
  parseRpcResponseEnvelope,
  parseStreamFrame,
  safelyCall,
  type RpcResponseEnvelope,
} from "./protocol.ts";
import {
  RpcDefectError,
  type AnyEvent,
  type AnyMethod,
  type EventDecodeMode,
  type EventSubscribe,
  type EventSubscriber,
  type EventSubscriberOptions,
  type RpcCaller,
  type RpcClient,
  type RpcClientOptions,
  type RpcInvoke,
  type RpcMethodError,
  type StreamMethodError,
  type StreamRpcCaller,
  type StreamRpcClient,
  type StreamRpcClientHandle,
  type StreamRpcClientOptions,
} from "./types.ts";

function requireInvoke(options?: RpcClientOptions): RpcInvoke {
  if (!options?.invoke) {
    throw new Error("RpcClientOptions.invoke is required.");
  }
  return options.invoke;
}

function requireSubscribe(options?: EventSubscriberOptions): EventSubscribe {
  if (!options?.subscribe) {
    throw new Error("EventSubscriberOptions.subscribe is required.");
  }
  return options.subscribe;
}

type MutableRpcClient<
  C extends RpcContract<readonly AnyMethod[], readonly AnyEvent[], readonly AnyStreamMethod[]>,
> = {
  -readonly [Name in keyof RpcClient<C>]: RpcClient<C>[Name];
};

function rpcDefect(code: RpcDefectError["code"], message: string, cause: unknown): RpcDefectError {
  return new RpcDefectError(code, message, cause);
}

function decodeNonEmptyError(schema: import("./contract.ts").ErrorSchema, data: unknown) {
  if (isNoErrorSchema(schema)) {
    throw new Error("unreachable: caller must check isNoErrorSchema first");
  }
  return S.decodeUnknownSync(schema)(data);
}

function decodeLegacyExit<M extends AnyMethod>(
  method: M,
  raw: unknown,
): Effect.Effect<RpcOutput<M>, RpcMethodError<M>> {
  return Effect.try({
    try: () => S.decodeUnknownSync(exitSchemaFor(method))(raw),
    catch: (cause) =>
      rpcDefect(
        "legacy_decode_failed",
        `RPC ${method.name} legacy response decoding failed: ${formatUnknown(cause)}`,
        cause,
      ),
  }).pipe(
    Effect.flatMap((exit) => {
      if (Exit.isSuccess(exit)) {
        return Effect.succeed(exit.value);
      }

      const failureOption = Cause.failureOption(exit.cause);
      if (failureOption._tag === "Some") {
        return Effect.fail<RpcMethodError<M>>(failureOption.value);
      }

      const defectOption = Cause.dieOption(exit.cause);
      if (defectOption._tag === "Some") {
        const defect = defectOption.value;
        const message = defect instanceof Error ? defect.message : String(defect);
        return Effect.fail(rpcDefect("remote_defect", message, defect));
      }

      return Effect.fail(
        rpcDefect("remote_defect", "RPC call was interrupted or failed unexpectedly", exit.cause),
      );
    }),
  );
}

export function createRpcClient<
  const Methods extends ReadonlyArray<AnyMethod>,
  const Events extends ReadonlyArray<AnyEvent>,
  const StreamMethods extends ReadonlyArray<AnyStreamMethod> = readonly [],
>(
  contract: RpcContract<Methods, Events, StreamMethods>,
  options: RpcClientOptions,
): RpcClient<RpcContract<Methods, Events, StreamMethods>> {
  const invoke = requireInvoke(options);
  const diagnostics = options?.diagnostics;
  const decodeMode = options?.rpcDecodeMode ?? "envelope";

  const decodeEnvelope = <M extends Methods[number]>(
    method: M,
    envelope: RpcResponseEnvelope,
  ): Effect.Effect<RpcOutput<M>, RpcMethodError<M>> => {
    switch (envelope.type) {
      case "success":
        return Effect.try({
          try: () => S.decodeUnknownSync(method.res)(envelope.data),
          catch: (cause) => {
            safelyCall(diagnostics?.onDecodeFailure, {
              scope: "rpc-response",
              name: method.name,
              payload: envelope.data,
              cause,
            });

            return rpcDefect(
              "success_payload_decoding_failed",
              `RPC ${method.name} success payload decoding failed: ${formatUnknown(cause)}`,
              cause,
            );
          },
        });

      case "failure":
        if (isNoErrorSchema(method.err)) {
          return Effect.fail(
            rpcDefect(
              "noerror_contract_violation",
              `RPC ${method.name} received a failure for a method that declares NoError`,
              envelope.error,
            ),
          );
        }

        return Effect.try({
          try: () => decodeNonEmptyError(method.err, envelope.error.data),
          catch: (cause) => {
            safelyCall(diagnostics?.onDecodeFailure, {
              scope: "rpc-response",
              name: method.name,
              payload: envelope.error,
              cause,
            });

            return rpcDefect(
              "failure_payload_decoding_failed",
              `RPC ${method.name} failure payload decoding failed: ${formatUnknown(cause)}`,
              cause,
            );
          },
        }).pipe(Effect.flatMap((decodedError) => Effect.fail<RpcMethodError<M>>(decodedError)));

      case "defect":
        return Effect.fail(rpcDefect("remote_defect", envelope.message, envelope.cause));
    }
  };

  const call = <M extends Methods[number]>(
    method: M,
    input: RpcInput<M>,
  ): Effect.Effect<RpcOutput<M>, RpcMethodError<M>> =>
    Effect.try({
      try: () => S.encodeSync(method.req)(input),
      catch: (cause) => {
        safelyCall(diagnostics?.onDecodeFailure, {
          scope: "rpc-request",
          name: method.name,
          payload: input,
          cause,
        });

        return rpcDefect(
          "request_encoding_failed",
          `RPC ${method.name} request encoding failed: ${formatUnknown(cause)}`,
          cause,
        );
      },
    }).pipe(
      Effect.flatMap((encoded) =>
        Effect.tryPromise({
          try: () => invoke(method.name, encoded),
          catch: (cause) => {
            safelyCall(diagnostics?.onProtocolError, {
              method: method.name,
              response: undefined,
              cause,
            });

            return rpcDefect(
              "invoke_failed",
              `RPC ${method.name} invoke failed: ${formatUnknown(cause)}`,
              cause,
            );
          },
        }),
      ),
      Effect.flatMap((raw) => {
        const envelope = parseRpcResponseEnvelope(raw);
        if (envelope) {
          return decodeEnvelope(method, envelope);
        }

        if (decodeMode === "dual") {
          return decodeLegacyExit(method, raw).pipe(
            Effect.tapError((cause) => {
              if (cause instanceof RpcDefectError && cause.code === "legacy_decode_failed") {
                return Effect.sync(() =>
                  safelyCall(diagnostics?.onProtocolError, {
                    method: method.name,
                    response: raw,
                    cause,
                  }),
                );
              }

              return Effect.void;
            }),
          );
        }

        const cause = rpcDefect(
          "invalid_response_envelope",
          `RPC ${method.name} response was not a valid envelope.`,
          raw,
        );
        safelyCall(diagnostics?.onProtocolError, {
          method: method.name,
          response: raw,
          cause,
        });

        return Effect.fail(cause);
      }),
    );

  const client: MutableRpcClient<RpcContract<Methods, Events, StreamMethods>> = Object.create(null);
  const clientRecord: Record<string, unknown> = client;

  for (const method of contract.methods) {
    const caller: RpcCaller<typeof method> = (...args: [RpcInput<typeof method>?]) => {
      const payload: RpcInput<typeof method> = args.length === 0 ? {} : args[0]!;
      return call(method, payload);
    };

    clientRecord[method.name] = caller;
  }

  return client;
}

function reportDecodeFailure(
  mode: EventDecodeMode,
  eventName: string,
  payload: unknown,
  cause: unknown,
  options?: EventSubscriberOptions,
): void {
  safelyCall(options?.diagnostics?.onDecodeFailure, {
    scope: "event-payload",
    name: eventName,
    payload,
    cause,
  });

  if (mode === "strict") {
    throw cause;
  }
}

export function createEventSubscriber<
  const Methods extends ReadonlyArray<AnyMethod>,
  const Events extends ReadonlyArray<AnyEvent>,
  const StreamMethods extends ReadonlyArray<AnyStreamMethod> = readonly [],
>(
  contract: RpcContract<Methods, Events, StreamMethods>,
  options: EventSubscriberOptions,
): EventSubscriber<RpcContract<Methods, Events, StreamMethods>> {
  const subscribe = requireSubscribe(options);
  const mode = options?.decodeMode ?? "safe";

  const eventMap = new Map<string, Events[number]>();
  const subscriptions = new Set<() => void>();

  for (const event of contract.events) {
    eventMap.set(event.name, event);
  }

  function registerUnsubscribe(unsubscribe: () => void): () => void {
    subscriptions.add(unsubscribe);

    return () => {
      if (subscriptions.delete(unsubscribe)) {
        unsubscribe();
      }
    };
  }

  const subscribeEvent = <E extends Events[number]>(
    event: E,
    handler: (payload: RpcEventPayload<E>) => void,
  ) => {
    const decoder = S.decodeUnknownSync(event.payload);
    const unsubscribe = subscribe(event.name, (payload) => {
      let decoded: RpcEventPayload<E>;
      try {
        decoded = decoder(payload);
      } catch (cause) {
        reportDecodeFailure(mode, event.name, payload, cause, options);
        return;
      }

      handler(decoded);
    });

    return registerUnsubscribe(unsubscribe);
  };

  const subscribeByName = (name: string, handler: (payload: unknown) => void) => {
    const event = eventMap.get(name);
    if (!event) {
      throw new Error(`Unknown event: ${name}`);
    }

    const decoder = S.decodeUnknownSync(event.payload);
    const unsubscribe = subscribe(name, (payload) => {
      let decoded: unknown;
      try {
        decoded = decoder(payload);
      } catch (cause) {
        reportDecodeFailure(mode, name, payload, cause, options);
        return;
      }

      handler(decoded);
    });

    return registerUnsubscribe(unsubscribe);
  };

  function dispose(): void {
    let firstError: unknown;

    for (const unsubscribe of subscriptions) {
      try {
        unsubscribe();
      } catch (cause) {
        firstError ??= cause;
      }
    }

    subscriptions.clear();

    if (firstError !== undefined) {
      throw firstError;
    }
  }

  return {
    subscribe: subscribeEvent,
    subscribeByName,
    dispose,
  };
}

function isStreamStartedResponse(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type === "success" && isRecord(value.data)) {
    return value.data.type === "stream_started";
  }
  return false;
}

export function createStreamRpcClient<
  const Methods extends ReadonlyArray<AnyMethod>,
  const Events extends ReadonlyArray<AnyEvent>,
  const StreamMethods extends ReadonlyArray<AnyStreamMethod>,
>(
  contract: RpcContract<Methods, Events, StreamMethods>,
  options: StreamRpcClientOptions,
): StreamRpcClientHandle<RpcContract<Methods, Events, StreamMethods>> {
  const invoke = options.invoke;
  const onStreamFrame = options.onStreamFrame;
  const diagnostics = options.diagnostics;
  const streamBuffer = options.streamBuffer ?? { bufferSize: "unbounded" as const };

  type FrameHandler = {
    data: (payload: unknown) => void;
    end: () => void;
    error: (error: { tag: string; data: unknown }) => void;
    defect: (message: string) => void;
  };

  const frameDispatcher = new Map<string, FrameHandler>();

  // Set up central frame listener
  const centralCleanup = onStreamFrame((raw: unknown) => {
    const frame = parseStreamFrame(raw);
    if (!frame) {
      // Best-effort: extract streamId from malformed frame to fail the active stream
      const rawStreamId = extractStreamIdFromRaw(raw);
      if (rawStreamId) {
        const handler = frameDispatcher.get(rawStreamId);
        if (handler) {
          handler.defect("Malformed stream frame received");
          frameDispatcher.delete(rawStreamId);
        }
      }
      safelyCall(diagnostics?.onProtocolError, {
        method: "stream-frame",
        response: raw,
        cause: null,
      });
      return;
    }

    const handler = frameDispatcher.get(frame.streamId);
    if (!handler) return; // stale frame for completed/cancelled stream

    switch (frame.type) {
      case "data":
        handler.data(frame.payload);
        break;
      case "end":
        handler.end();
        frameDispatcher.delete(frame.streamId);
        break;
      case "error":
        handler.error(frame.error);
        frameDispatcher.delete(frame.streamId);
        break;
      case "defect":
        handler.defect(frame.message);
        frameDispatcher.delete(frame.streamId);
        break;
    }
  });

  const streamMethods = contract.streamMethods ?? [];

  type MutableStreamRpcClient = {
    -readonly [Name in keyof StreamRpcClient<
      RpcContract<Methods, Events, StreamMethods>
    >]: StreamRpcClient<RpcContract<Methods, Events, StreamMethods>>[Name];
  };

  const client: MutableStreamRpcClient = Object.create(null);
  const clientRecord: Record<string, unknown> = client;

  for (const method of streamMethods) {
    const decodeChunk = S.decodeUnknownSync(method.chunk);
    const encodeInput = S.encodeSync(method.req);
    const decodeTypedError = isNoErrorSchema(method.err) ? null : S.decodeUnknownSync(method.err);

    const caller: StreamRpcCaller<typeof method> = (...args: [StreamInput<typeof method>?]) => {
      const payload: StreamInput<typeof method> = args.length === 0 ? {} : args[0]!;

      return Stream.asyncPush<StreamChunk<typeof method>, StreamMethodError<typeof method>>(
        (emit) =>
          Effect.gen(function* () {
            const streamId = crypto.randomUUID();

            // 1. Register in dispatch map BEFORE calling invoke
            frameDispatcher.set(streamId, {
              data: (rawPayload) => {
                let decoded: StreamChunk<typeof method>;
                try {
                  decoded = decodeChunk(rawPayload);
                } catch (cause) {
                  const context: import("./types.ts").DecodeFailureContext = {
                    scope: "stream-chunk",
                    name: method.name,
                    payload: rawPayload,
                    cause,
                  };
                  safelyCall(diagnostics?.onDecodeFailure, context);
                  emit.fail(
                    rpcDefect(
                      "stream_chunk_decode_failed",
                      `Stream ${method.name} chunk decode failed: ${formatUnknown(cause)}`,
                      cause,
                    ),
                  );
                  return;
                }
                // `emit.single(...) === false` indicates a closed emitter, not
                // bounded-buffer overflow.
                const accepted = emit.single(decoded);
                if (!accepted) {
                  // Stream has already finished. Remove dispatcher entry on the
                  // first post-close frame to avoid repeated diagnostics.
                  frameDispatcher.delete(streamId);
                  safelyCall(diagnostics?.onProtocolError, {
                    method: method.name,
                    response: rawPayload,
                    cause: new Error(
                      `Stream ${method.name} received a post-close data frame; frame ignored`,
                    ),
                  });
                }
              },
              end: () => emit.end(),
              error: (err) => {
                if (!decodeTypedError) {
                  emit.fail(
                    rpcDefect(
                      "stream_error_decode_failed",
                      `Stream ${method.name} received typed error but declares NoError`,
                      err,
                    ),
                  );
                  return;
                }

                try {
                  const decoded = decodeNonEmptyError(method.err, err.data);
                  emit.fail(decoded);
                } catch (cause) {
                  const errContext: import("./types.ts").DecodeFailureContext = {
                    scope: "stream-error",
                    name: method.name,
                    payload: err,
                    cause,
                  };
                  safelyCall(diagnostics?.onDecodeFailure, errContext);
                  emit.fail(
                    rpcDefect(
                      "stream_error_decode_failed",
                      `Stream ${method.name} error decode failed: ${formatUnknown(cause)}`,
                      cause,
                    ),
                  );
                }
              },
              defect: (message) => emit.fail(rpcDefect("remote_defect", message, undefined)),
            });

            // 2. Register cleanup finalizer
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                frameDispatcher.delete(streamId);
              }).pipe(
                Effect.andThen(
                  Effect.tryPromise(() => invoke(`stream-cancel`, { streamId })).pipe(
                    Effect.ignore,
                  ),
                ),
              ),
            );

            // 3. Encode input
            const encodedInput = yield* Effect.try({
              try: () => encodeInput(payload),
              catch: (cause) =>
                rpcDefect(
                  "request_encoding_failed",
                  `Stream ${method.name} request encoding failed: ${formatUnknown(cause)}`,
                  cause,
                ),
            });

            // 4. Initiate the stream on main
            const response = yield* Effect.tryPromise({
              try: () =>
                invoke(`stream/${method.name}`, {
                  data: encodedInput,
                  streamId,
                }),
              catch: (cause) =>
                rpcDefect(
                  "stream_invoke_failed",
                  `Stream ${method.name} invoke failed: ${formatUnknown(cause)}`,
                  cause,
                ),
            });

            // 5. Validate handshake response
            const envelope = parseRpcResponseEnvelope(response);
            if (envelope?.type === "defect") {
              return yield* Effect.fail(
                rpcDefect("remote_defect", envelope.message, envelope.cause),
              );
            }

            if (!isStreamStartedResponse(response)) {
              return yield* Effect.fail(
                rpcDefect(
                  "stream_handshake_invalid",
                  `Stream ${method.name} unexpected handshake response`,
                  response,
                ),
              );
            }
          }),
        streamBuffer,
      );
    };

    clientRecord[method.name] = caller;
  }

  function dispose(): void {
    // Fail all active streams so consumers don't hang
    for (const [streamId, handler] of frameDispatcher) {
      handler.defect("Stream client disposed");
      frameDispatcher.delete(streamId);
    }
    centralCleanup();
  }

  return {
    client,
    dispose,
  };
}

export { RpcDefectError } from "./types.ts";
