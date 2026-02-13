import * as S from "@effect/schema/Schema";
import { Cause, Exit } from "effect";
import {
  exitSchemaFor,
  isNoErrorSchema,
  type RpcContract,
  type RpcEventPayload,
  type RpcInput,
  type RpcOutput,
} from "./contract.ts";
import { formatUnknown, parseRpcResponseEnvelope, safelyCall } from "./protocol.ts";
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

function decodeLegacyExit<M extends AnyMethod>(
  method: M,
  raw: unknown
): RpcOutput<M> {
  const exitSchema = exitSchemaFor(method);
  const decodeExit = S.decodeUnknownSync(exitSchema);
  const exit = decodeExit(raw);

  if (Exit.isSuccess(exit)) {
    return exit.value;
  }

  const failureOption = Cause.failureOption(exit.cause);
  if (failureOption._tag === "Some") {
    throw failureOption.value;
  }

  const defectOption = Cause.dieOption(exit.cause);
  if (defectOption._tag === "Some") {
    const defect = defectOption.value;
    if (defect instanceof Error) {
      throw new RpcDefectError(defect.message, defect);
    }

    throw new RpcDefectError(String(defect), defect);
  }

  throw new RpcDefectError(
    "RPC call was interrupted or failed unexpectedly",
    exit.cause
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

  const call = async <M extends Methods[number]>(
    method: M,
    input: RpcInput<M>
  ): Promise<RpcOutput<M>> => {
    let encoded: unknown;
    try {
      encoded = S.encodeSync(method.req)(input);
    } catch (cause) {
      safelyCall(diagnostics?.onDecodeFailure, {
        scope: "rpc-request",
        name: method.name,
        payload: input,
        cause,
      });

      throw new Error(
        `RPC ${method.name} request encoding failed: ${formatUnknown(cause)}`
      );
    }

    let raw: unknown;
    try {
      raw = await invoke(method.name, encoded);
    } catch (cause) {
      safelyCall(diagnostics?.onProtocolError, {
        method: method.name,
        response: undefined,
        cause,
      });

      throw new RpcDefectError(
        `RPC ${method.name} invoke failed: ${formatUnknown(cause)}`,
        cause
      );
    }

    const envelope = parseRpcResponseEnvelope(raw);
    if (envelope) {
      switch (envelope.type) {
        case "success":
          try {
            return S.decodeUnknownSync(method.res)(envelope.data);
          } catch (cause) {
            safelyCall(diagnostics?.onDecodeFailure, {
              scope: "rpc-response",
              name: method.name,
              payload: envelope.data,
              cause,
            });

            throw new Error(
              `RPC ${method.name} success payload decoding failed: ${formatUnknown(cause)}`
            );
          }

        case "failure":
          if (isNoErrorSchema(method.err)) {
            throw new RpcDefectError(
              `RPC ${method.name} received a failure for a method that declares NoError`,
              envelope.error
            );
          }

          let decodedError: unknown;
          try {
            decodedError = S.decodeUnknownSync(method.err)(envelope.error.data);
          } catch (cause) {
            safelyCall(diagnostics?.onDecodeFailure, {
              scope: "rpc-response",
              name: method.name,
              payload: envelope.error,
              cause,
            });

            throw new Error(
              `RPC ${method.name} failure payload decoding failed: ${formatUnknown(cause)}`
            );
          }

          throw decodedError;

        case "defect":
          throw new RpcDefectError(envelope.message, envelope.cause);
      }
    }

    if (decodeMode === "dual") {
      try {
        return decodeLegacyExit(method, raw);
      } catch (cause) {
        safelyCall(diagnostics?.onProtocolError, {
          method: method.name,
          response: raw,
          cause,
        });

        throw cause;
      }
    }

    const cause = new Error(`RPC ${method.name} response was not a valid envelope.`);
    safelyCall(diagnostics?.onProtocolError, {
      method: method.name,
      response: raw,
      cause,
    });

    throw cause;
  };

  const client: MutableRpcClient<RpcContract<Methods, Events>> =
    Object.create(null);
  const clientRecord: Record<string, unknown> = client;

  for (const method of contract.methods) {
    const decodeDefaultInput = S.decodeUnknownSync(method.req);

    const caller: RpcCaller<typeof method> = (
      ...args: [RpcInput<typeof method>?]
    ) => {
      const payload =
        args.length === 0
          ? decodeDefaultInput({})
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
