import * as S from "@effect/schema/Schema";
import { Cause, Exit } from "effect";
import {
  exitSchemaFor,
  type RpcContract,
  type RpcEventPayload,
  type RpcInput,
  type RpcOutput,
} from "./contract.ts";
import {
  RpcDefectError,
  type AnyEvent,
  type AnyMethod,
  type EventSubscriber,
  type EventSubscriberOptions,
  type RpcCaller,
  type RpcClient,
  type RpcClientOptions,
} from "./types.ts";

const formatCause = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const requireInvoke = (options?: RpcClientOptions) => {
  if (!options?.invoke) {
    throw new Error("RpcClientOptions.invoke is required.");
  }
  return options.invoke;
};

const requireSubscribe = (options?: EventSubscriberOptions) => {
  if (!options?.subscribe) {
    throw new Error("EventSubscriberOptions.subscribe is required.");
  }
  return options.subscribe;
};

type MutableRpcClient<
  C extends RpcContract<readonly AnyMethod[], readonly AnyEvent[]>
> = {
  -readonly [Name in keyof RpcClient<C>]: RpcClient<C>[Name];
};

export const createRpcClient = <
  const Methods extends ReadonlyArray<AnyMethod>,
  const Events extends ReadonlyArray<AnyEvent>
>(
  contract: RpcContract<Methods, Events>,
  options?: RpcClientOptions
): RpcClient<RpcContract<Methods, Events>> => {
  const invoke = requireInvoke(options);

  const call = async <M extends Methods[number]>(
    method: M,
    input: RpcInput<M>
  ): Promise<RpcOutput<M>> => {
    let encoded: unknown;
    try {
      encoded = S.encodeSync(method.req)(input);
    } catch (cause) {
      throw new Error(
        `RPC ${method.name} request encoding failed: ${formatCause(cause)}`
      );
    }

    const raw = await invoke(method.name, encoded);

    const exitSchema = exitSchemaFor(method);
    const decodeExit = S.decodeUnknownSync(exitSchema);
    let exit: ReturnType<typeof decodeExit>;

    try {
      exit = decodeExit(raw);
    } catch (cause) {
      throw new Error(
        `RPC ${method.name} response decoding failed: ${formatCause(cause)}`
      );
    }

    if (Exit.isSuccess(exit)) {
      return exit.value;
    }

    const cause = exit.cause;
    const failureOption = Cause.failureOption(cause);
    if (failureOption._tag === "Some") {
      throw failureOption.value;
    }

    const defectOption = Cause.dieOption(cause);
    if (defectOption._tag === "Some") {
      const defect = defectOption.value;
      if (defect instanceof Error) {
        throw new RpcDefectError(defect.message, defect);
      }
      throw new RpcDefectError(String(defect), defect);
    }

    throw new RpcDefectError(
      "RPC call was interrupted or failed unexpectedly",
      cause
    );
  };

  const client: MutableRpcClient<RpcContract<Methods, Events>> =
    Object.create(null);
  const clientRecord: Record<string, unknown> = client;

  contract.methods.forEach((method: Methods[number]) => {
    const caller: RpcCaller<typeof method> = (
      input?: RpcInput<typeof method>
    ) => {
      const payload = input ?? S.decodeUnknownSync(method.req)({});
      return call(method, payload);
    };

    clientRecord[method.name] = caller;
  });

  return client;
};

export const createEventSubscriber = <
  const Methods extends ReadonlyArray<AnyMethod>,
  const Events extends ReadonlyArray<AnyEvent>
>(
  contract: RpcContract<Methods, Events>,
  options?: EventSubscriberOptions
): EventSubscriber<RpcContract<Methods, Events>> => {
  const subscribe = requireSubscribe(options);
  const eventMap = new Map<string, Events[number]>();

  for (const event of contract.events) {
    eventMap.set(event.name, event);
  }

  const subscribeEvent = <E extends Events[number]>(
    event: E,
    handler: (payload: RpcEventPayload<E>) => void
  ) => {
    const decoder = S.decodeUnknownSync(event.payload);
    return subscribe(event.name, (payload) => {
      const decoded = decoder(payload);
      handler(decoded);
    });
  };

  const subscribeByName = (
    name: Events[number]["name"],
    handler: (payload: unknown) => void
  ) => {
    const event = eventMap.get(name);
    if (!event) {
      throw new Error(`Unknown event: ${name}`);
    }

    const decoder = S.decodeUnknownSync(event.payload);
    return subscribe(name, (payload) => handler(decoder(payload)));
  };

  return {
    subscribe: subscribeEvent,
    subscribeByName,
  };
};

export { RpcDefectError } from "./types.ts";
