import { describe, expect, test } from "bun:test";
import { Deferred, Effect, Fiber, Schedule, Schema, Scope, Stream } from "effect";
import { Rpc, RpcClient, RpcClientError, RpcGroup, RpcServer } from "effect/unstable/rpc";
import * as PortProtocol from "../src/PortProtocol.ts";
import { makeChannel, type FakePort } from "./support/ports.ts";

const Rpcs = RpcGroup.make(
  Rpc.make("Echo", { payload: { text: Schema.String }, success: Schema.String }),
  Rpc.make("Hang"),
  Rpc.make("Naturals", { success: Schema.Number, stream: true }),
);

interface Probe {
  readonly hangStarted: Deferred.Deferred<void>;
  readonly hangInterrupted: Deferred.Deferred<void>;
  hangCalls: number;
  produced: number;
}

const makeProbe = (): Probe => ({
  hangStarted: Deferred.makeUnsafe(),
  hangInterrupted: Deferred.makeUnsafe(),
  hangCalls: 0,
  produced: 0,
});

const handlers = (probe: Probe) =>
  Rpcs.toLayer({
    Echo: ({ text }) => Effect.succeed(text),
    Hang: () =>
      Effect.sync(() => probe.hangCalls++).pipe(
        Effect.andThen(Deferred.succeed(probe.hangStarted, undefined)),
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Deferred.succeed(probe.hangInterrupted, undefined)),
      ),
    Naturals: () => Stream.fromEffectRepeat(Effect.sync(() => probe.produced++)),
  });

interface HarnessOptions {
  /** When false, connections wait until `acceptPending` is called. */
  readonly autoAccept?: boolean;
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
  const unaccepted: Array<FakePort> = [];
  const connect = Effect.acquireRelease(
    Effect.sync(() => {
      const { port1, port2 } = makeChannel();
      serverEnds.push(port2);
      if (options.rejectWith !== undefined) {
        PortProtocol.reject(port2, options.rejectWith);
      } else if (options.autoAccept === false) {
        unaccepted.push(port2);
      } else {
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
  const makeRpcClient = RpcClient.make(Rpcs).pipe(
    Effect.provideService(RpcClient.Protocol, protocol),
  );
  const client = yield* makeRpcClient;

  const acceptPending = () => {
    for (const port of unaccepted.splice(0)) {
      server.accept(port, undefined);
    }
  };

  return { client, makeRpcClient, serverEnds, acceptPending };
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

  test("interrupting a call interrupts the server-side handler", () =>
    run(
      Effect.gen(function* () {
        const probe = makeProbe();
        const { client } = yield* makeHarness(probe);

        const call = yield* Effect.forkChild(client.Hang());
        yield* within(Deferred.await(probe.hangStarted));
        yield* Fiber.interrupt(call);

        yield* within(Deferred.await(probe.hangInterrupted));
      }),
    ));

  test("a client disconnecting interrupts its in-flight handlers", () =>
    run(
      Effect.gen(function* () {
        const probe = makeProbe();
        const { client, serverEnds } = yield* makeHarness(probe);

        yield* Effect.forkChild(client.Hang());
        yield* within(Deferred.await(probe.hangStarted));
        // The renderer went away (reload, crash, window closed).
        serverEnds[0]!.peer!.close();

        yield* within(Deferred.await(probe.hangInterrupted));
      }),
    ));

  test("a dropped connection fails in-flight calls, then reconnects for new ones", () =>
    run(
      Effect.gen(function* () {
        const probe = makeProbe();
        const { client, serverEnds } = yield* makeHarness(probe);

        const call = yield* Effect.forkChild(client.Hang());
        yield* within(Deferred.await(probe.hangStarted));
        serverEnds[0]!.close();

        const error = yield* within(Effect.flip(Fiber.join(call)));
        expect(reasonTag(error)).toBe("SocketCloseError");
        // Resumed synchronously inside the failure delivery; let it finish.
        yield* Effect.yieldNow;

        expect(yield* within(client.Echo({ text: "after reconnect" }))).toBe("after reconnect");
        expect(serverEnds).toHaveLength(2);
      }),
    ));

  test("a call started while a dropped connection is failing is not run after reconnecting", () =>
    run(
      Effect.gen(function* () {
        const probe = makeProbe();
        const { client, serverEnds } = yield* makeHarness(probe);

        const call = yield* Effect.forkChild(client.Hang());
        yield* within(Deferred.await(probe.hangStarted));
        serverEnds[0]!.close();

        // Retry without yielding, as `Effect.retry` with no delay would.
        const retryError = yield* within(
          Fiber.join(call).pipe(Effect.flip, Effect.andThen(Effect.flip(client.Hang()))),
        );
        expect(reasonTag(retryError)).toBe("SocketCloseError");
        yield* Effect.yieldNow;

        yield* within(client.Echo({ text: "reconnected" }));
        expect(probe.hangCalls).toBe(1);
      }),
    ));

  test("calls made before the handshake completes are delivered once it does", () =>
    run(
      Effect.gen(function* () {
        const probe = makeProbe();
        const { client, acceptPending } = yield* makeHarness(probe, { autoAccept: false });

        const call = yield* Effect.forkChild(client.Echo({ text: "early" }));
        yield* Effect.sleep(20);
        acceptPending();

        expect(yield* within(Fiber.join(call))).toBe("early");
      }),
    ));

  test("a call interrupted while queued is never run by the server", () =>
    run(
      Effect.gen(function* () {
        const probe = makeProbe();
        const { client, acceptPending } = yield* makeHarness(probe, { autoAccept: false });

        const queued = yield* Effect.forkChild(client.Hang());
        yield* Effect.sleep(20);
        yield* Fiber.interrupt(queued);
        acceptPending();

        // A later call completing proves the queue was flushed past the
        // interrupted request.
        yield* within(client.Echo({ text: "flushed" }));
        expect(Deferred.isDoneUnsafe(probe.hangStarted)).toBe(false);
      }),
    ));

  test("once the retry schedule gives up, queued and later calls fail", () =>
    run(
      Effect.gen(function* () {
        const probe = makeProbe();
        const { client } = yield* makeHarness(probe, {
          autoAccept: false,
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

  test("clients sharing one connection each receive their own responses", () =>
    run(
      Effect.gen(function* () {
        const probe = makeProbe();
        const { client, makeRpcClient } = yield* makeHarness(probe);
        const second = yield* makeRpcClient;

        const results = yield* within(
          Effect.all([client.Echo({ text: "first" }), second.Echo({ text: "second" })], {
            concurrency: "unbounded",
          }),
        );

        expect(results).toEqual(["first", "second"]);
      }),
    ));
});
