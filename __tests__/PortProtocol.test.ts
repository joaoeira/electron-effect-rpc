import { describe, expect, test } from "bun:test";
import { Effect, Schedule, Schema, Scope, Stream } from "effect";
import { Rpc, RpcClient, RpcClientError, RpcGroup, RpcServer } from "effect/rpc";
import * as PortProtocol from "../src/PortProtocol.ts";
import { makeChannel, type FakePort } from "./support/ports.ts";

// Behavior the generated histories in PortProtocol.property.test.ts don't
// model: stream backpressure, refusal, giving up on reconnecting, and
// malformed messages.

const Rpcs = RpcGroup.make(
  Rpc.make("Echo", { payload: { text: Schema.String }, success: Schema.String }),
  Rpc.make("Naturals", { success: Schema.Number, stream: true }),
);

interface Probe {
  produced: number;
}

const makeProbe = (): Probe => ({ produced: 0 });

const handlers = (probe: Probe) =>
  Rpcs.toLayer({
    Echo: ({ text }) => Effect.succeed(text),
    Naturals: () => Stream.fromEffectRepeat(Effect.sync(() => probe.produced++)),
  });

interface HarnessOptions {
  /** When false, connections are never accepted. */
  readonly accept?: boolean;
  /** Refuse every connection with this reason. */
  readonly rejectWith?: string;
  readonly handshakeTimeout?: number;
  readonly retrySchedule?: Schedule.Schedule<unknown, RpcClientError.RpcClientError>;
}

const makeHarness = Effect.fnUntraced(function* (probe: Probe, options: HarnessOptions = {}) {
  const server = yield* PortProtocol.makeServer<void>();
  yield* RpcServer.make(Rpcs).pipe(
    Effect.provideService(RpcServer.Protocol, server.protocol),
    Effect.provide(handlers(probe)),
    Effect.forkScoped,
  );

  const serverEnds: Array<FakePort> = [];
  const connect = Effect.acquireRelease(
    Effect.sync(() => {
      const { port1, port2 } = makeChannel();
      serverEnds.push(port2);
      if (options.rejectWith !== undefined) {
        PortProtocol.reject(port2, options.rejectWith);
      } else if (options.accept !== false) {
        server.accept(port2, undefined);
      }
      return port1;
    }),
    (port) => Effect.sync(() => port.close()),
  );

  const protocol = yield* PortProtocol.makeClient({
    connect,
    handshakeTimeout: options.handshakeTimeout,
    retrySchedule: options.retrySchedule,
  });
  const client = yield* RpcClient.make(Rpcs).pipe(
    Effect.provideService(RpcClient.Protocol, protocol),
  );

  return { client, serverEnds };
});

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(effect));

const within = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.timeoutOrElse(effect, {
    duration: 2000,
    orElse: () => Effect.die(new Error("timed out")),
  });

const reasonTag = (error: RpcClientError.RpcClientError) => error.reason._tag;

describe("PortProtocol", () => {
  test("a slow stream consumer holds the server-side producer back", () =>
    run(
      Effect.gen(function* () {
        const probe = makeProbe();
        const { client } = yield* makeHarness(probe);

        const values = yield* client.Naturals().pipe(
          Stream.tap(() => Effect.sleep(20)),
          Stream.take(5),
          Stream.runCollect,
        );

        expect(values).toEqual([0, 1, 2, 3, 4]);
        // Without acknowledgements the producer would have emitted thousands
        // of values in 100ms. With them it stays within the client's stream
        // buffer (16) of what was consumed.
        expect(probe.produced).toBeLessThan(30);
      }),
    ));

  test("once the retry schedule gives up, queued and later calls fail", () =>
    run(
      Effect.gen(function* () {
        const probe = makeProbe();
        const { client } = yield* makeHarness(probe, {
          accept: false,
          handshakeTimeout: 30,
          retrySchedule: Schedule.recurs(1),
        });

        const queuedError = yield* within(Effect.flip(client.Echo({ text: "queued" })));
        const laterError = yield* within(Effect.flip(client.Echo({ text: "later" })));

        expect(reasonTag(queuedError)).toBe("SocketOpenError");
        expect(reasonTag(laterError)).toBe("SocketOpenError");
      }),
    ));

  test("a rejected connection fails calls instead of reconnecting", () =>
    run(
      Effect.gen(function* () {
        const probe = makeProbe();
        const { client, serverEnds } = yield* makeHarness(probe, { rejectWith: "not allowed" });

        const error = yield* within(Effect.flip(client.Echo({ text: "hello" })));
        yield* Effect.sleep(300);

        expect(reasonTag(error)).toBe("RpcClientDefect");
        expect(error.reason).toMatchObject({ cause: "not allowed" });
        expect(serverEnds).toHaveLength(1);
      }),
    ));

  test("invalid messages from a peer do not break its connection", () =>
    run(
      Effect.gen(function* () {
        const probe = makeProbe();
        const { client, serverEnds } = yield* makeHarness(probe);
        yield* within(client.Echo({ text: "connected" }));

        const clientEnd = serverEnds[0]!.peer!;
        clientEnd.postJunk(null);
        clientEnd.postJunk("not a message");
        clientEnd.postJunk({ _tag: "Request" });
        clientEnd.postJunk({ _tag: "Unknown" });

        expect(yield* within(client.Echo({ text: "still works" }))).toBe("still works");
      }),
    ));
});
