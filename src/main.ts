import * as S from "@effect/schema/Schema";
import { Effect, PubSub, Stream } from "effect";
import * as Runtime from "effect/Runtime";
import {
  exitSchemaFor,
  type RpcContract,
  type RpcError,
  type RpcEventPayload,
  type RpcInput,
  type RpcOutput,
} from "./contract.ts";
import {
  defaultChannelPrefix,
  type AnyEvent,
  type AnyMethod,
  type EventBusOptions,
  type Implementations,
  type IpcMainLike,
  type RpcEventBus,
  type RpcServerOptions,
} from "./types.ts";

const resolveChannelPrefix = (prefix: EventBusOptions["channelPrefix"]) =>
  prefix ?? defaultChannelPrefix;

export const createRpcServer = <
  const Methods extends ReadonlyArray<AnyMethod>,
  const Events extends ReadonlyArray<AnyEvent>,
  R = never
>(
  contract: RpcContract<Methods, Events>,
  ipc: IpcMainLike,
  implementations: Implementations<RpcContract<Methods, Events>, R>,
  options?: RpcServerOptions<R>
): void => {
  const channelPrefix = resolveChannelPrefix(options?.channelPrefix);
  const runPromiseExit = <A, E>(effect: Effect.Effect<A, E, R>) => {
    if (options?.runtime) {
      return Runtime.runPromiseExit(options.runtime)(effect);
    }

    // @ts-expect-error -- default runtime only supports R=never when no runtime is provided
    return Effect.runPromiseExit(effect);
  };
  const implementationsByName: Implementations<RpcContract<Methods, Events>, R> &
    Record<string, unknown> = implementations;

  const methodNames = new Set(contract.methods.map((method) => method.name));

  for (const name in implementations) {
    if (!methodNames.has(name)) {
      throw new Error(`Implementation provided for unknown RPC method: ${name}`);
    }
  }

  contract.methods.forEach((method: Methods[number]) => {
    const impl = implementationsByName[method.name];
    if (!isImplementation<typeof method, R>(impl)) {
      throw new Error(`Missing implementation for RPC method: ${method.name}`);
    }

    const exitSchema = exitSchemaFor(method);
    const encodeExit = S.encodeUnknownSync(exitSchema);
    const decodeInput = S.decodeUnknownSync(method.req);
    const channel = `${channelPrefix.rpc}${method.name}`;

    ipc.handle(channel, async (_event, rawPayload) => {
      let input: RpcInput<typeof method>;
      try {
        input = decodeInput(rawPayload);
      } catch (cause) {
        const defectExit = await runPromiseExit(Effect.die(cause));
        return encodeExit(defectExit);
      }

      const exit = await runPromiseExit(impl(input));
      return encodeExit(exit);
    });
  });
};

type Envelope<E extends AnyEvent> = {
  readonly event: E;
  readonly payload: RpcEventPayload<E>;
};

const isImplementation = <M extends AnyMethod, R>(
  value: unknown
): value is (
  input: RpcInput<M>
) => Effect.Effect<RpcOutput<M>, RpcError<M>, R> => typeof value === "function";

const encodePayload = <E extends AnyEvent>(
  event: E,
  payload: RpcEventPayload<E>
) =>
  Effect.try({
    try: () => S.encodeSync(event.payload)(payload),
    catch: (cause) =>
      cause instanceof Error ? cause : new Error(String(cause)),
  });

const dispatchToRenderer = <E extends AnyEvent>(
  getWindow: EventBusOptions["getWindow"],
  channelPrefix: EventBusOptions["channelPrefix"],
  event: E,
  encoded: unknown
) =>
  Effect.sync(() => {
    const window = getWindow();
    if (window && !window.isDestroyed()) {
      const prefix = resolveChannelPrefix(channelPrefix);
      window.webContents.send(`${prefix.event}${event.name}`, encoded);
    }
  });

export const createEventBus = <
  const Methods extends ReadonlyArray<AnyMethod>,
  const Events extends ReadonlyArray<AnyEvent>
>(
  _contract: RpcContract<Methods, Events>,
  options: EventBusOptions
): RpcEventBus<RpcContract<Methods, Events>> => {
  const pubsub = Effect.runSync(
    PubSub.unbounded<Envelope<Events[number]>>()
  );

  Effect.runFork(
    Effect.scoped(
      Effect.gen(function* () {
        const dequeue = yield* PubSub.subscribe(pubsub);
        yield* Stream.fromQueue(dequeue, { shutdown: true }).pipe(
          Stream.runForEach(({ event, payload }) =>
            Effect.gen(function* () {
              const encodeResult = yield* Effect.either(
                encodePayload(event, payload)
              );

              if (encodeResult._tag === "Left") {
                return;
              }

              yield* dispatchToRenderer(
                options.getWindow,
                options.channelPrefix,
                event,
                encodeResult.right
              );
            })
          )
        );
      })
    ).pipe(
      Effect.catchAllCause(() => Effect.void),
      Effect.retry({ times: 3 }),
      Effect.catchAll(() => Effect.void)
    )
  );

  const emit = <E extends Events[number]>(
    event: E,
    payload: RpcEventPayload<E>
  ) =>
    Effect.flatMap(PubSub.publish(pubsub, { event, payload }), () =>
      Effect.void
    );

  return { emit };
};
