import * as S from "@effect/schema/Schema";
import { Cause, Effect, Exit } from "effect";
import {
  exitSchemaFor,
  isNoErrorSchema,
  type RpcContract,
  type RpcEventPayload,
  type RpcInput,
  type RpcOutput,
} from "./contract.ts";
import {
  formatUnknown,
  parseRpcResponseEnvelope,
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
  C extends RpcContract<readonly AnyMethod[], readonly AnyEvent[]>
> = {
  -readonly [Name in keyof RpcClient<C>]: RpcClient<C>[Name];
};

function rpcDefect(
  code: RpcDefectError["code"],
  message: string,
  cause: unknown
): RpcDefectError {
  return new RpcDefectError(code, message, cause);
}

function decodeLegacyExit<M extends AnyMethod>(
  method: M,
  raw: unknown
): Effect.Effect<RpcOutput<M>, RpcMethodError<M>> {
  return Effect.try({
    try: () => S.decodeUnknownSync(exitSchemaFor(method))(raw),
    catch: (cause) =>
      rpcDefect(
        "legacy_decode_failed",
        `RPC ${method.name} legacy response decoding failed: ${formatUnknown(cause)}`,
        cause
      ),
  }).pipe(
    Effect.flatMap((exit) => {
      if (Exit.isSuccess(exit)) {
        return Effect.succeed(exit.value);
      }

      const failureOption = Cause.failureOption(exit.cause);
      if (failureOption._tag === "Some") {
        return Effect.fail(failureOption.value as RpcMethodError<M>);
      }

      const defectOption = Cause.dieOption(exit.cause);
      if (defectOption._tag === "Some") {
        const defect = defectOption.value;
        const message = defect instanceof Error ? defect.message : String(defect);
        return Effect.fail(rpcDefect("remote_defect", message, defect));
      }

      return Effect.fail(
        rpcDefect(
          "remote_defect",
          "RPC call was interrupted or failed unexpectedly",
          exit.cause
        )
      );
    })
  );
}

export function createRpcClient<
  const Methods extends ReadonlyArray<AnyMethod>,
  const Events extends ReadonlyArray<AnyEvent>
>(
  contract: RpcContract<Methods, Events>,
  options: RpcClientOptions
): RpcClient<RpcContract<Methods, Events>> {
  const invoke = requireInvoke(options);
  const diagnostics = options?.diagnostics;
  const decodeMode = options?.rpcDecodeMode ?? "envelope";

  const decodeEnvelope = <M extends Methods[number]>(
    method: M,
    envelope: RpcResponseEnvelope
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
              cause
            );
          },
        });

      case "failure":
        if (isNoErrorSchema(method.err)) {
          return Effect.fail(
            rpcDefect(
              "noerror_contract_violation",
              `RPC ${method.name} received a failure for a method that declares NoError`,
              envelope.error
            )
          );
        }

        const errorSchema = method.err as S.Schema.AnyNoContext;
        return Effect.try({
          try: () => S.decodeUnknownSync(errorSchema)(envelope.error.data),
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
              cause
            );
          },
        }).pipe(
          Effect.flatMap((decodedError) =>
            Effect.fail(decodedError as RpcMethodError<M>)
          )
        );

      case "defect":
        return Effect.fail(
          rpcDefect("remote_defect", envelope.message, envelope.cause)
        );
    }
  };

  const call = <M extends Methods[number]>(
    method: M,
    input: RpcInput<M>
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
          cause
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
              cause
            );
          },
        })
      ),
      Effect.flatMap((raw) => {
        const envelope = parseRpcResponseEnvelope(raw);
        if (envelope) {
          return decodeEnvelope(method, envelope);
        }

        if (decodeMode === "dual") {
          return decodeLegacyExit(method, raw).pipe(
            Effect.tapError((cause) => {
              if (
                cause instanceof RpcDefectError &&
                cause.code === "legacy_decode_failed"
              ) {
                return Effect.sync(() =>
                  safelyCall(diagnostics?.onProtocolError, {
                    method: method.name,
                    response: raw,
                    cause,
                  })
                );
              }

              return Effect.void;
            })
          );
        }

        const cause = rpcDefect(
          "invalid_response_envelope",
          `RPC ${method.name} response was not a valid envelope.`,
          raw
        );
        safelyCall(diagnostics?.onProtocolError, {
          method: method.name,
          response: raw,
          cause,
        });

        return Effect.fail(cause);
      })
    );

  const client: MutableRpcClient<RpcContract<Methods, Events>> =
    Object.create(null);
  const clientRecord: Record<string, unknown> = client;

  for (const method of contract.methods) {
    const caller: RpcCaller<typeof method> = (
      ...args: [RpcInput<typeof method>?]
    ) => {
      const payload =
        args.length === 0
          ? ({} as RpcInput<typeof method>)
          : (args[0] as RpcInput<typeof method>);
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
  options?: EventSubscriberOptions
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
  const Events extends ReadonlyArray<AnyEvent>
>(
  contract: RpcContract<Methods, Events>,
  options: EventSubscriberOptions
): EventSubscriber<RpcContract<Methods, Events>> {
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
    handler: (payload: RpcEventPayload<E>) => void
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

  const subscribeByName = (
    name: string,
    handler: (payload: unknown) => void
  ) => {
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

export { RpcDefectError } from "./types.ts";
