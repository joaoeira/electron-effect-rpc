import { describe, expect, test } from "bun:test";
import {
  Cause,
  Clock,
  Effect,
  Exit,
  Fiber,
  Option,
  References,
  Schedule,
  Schema,
  Scope,
  Stream,
} from "effect";
import { FastCheck as fc, TestClock } from "effect/testing";
import { Rpc, RpcClient, RpcGroup, RpcServer } from "effect/unstable/rpc";
import type { RpcClientError } from "effect/unstable/rpc";
import * as PortProtocol from "../src/PortProtocol.ts";
import { Network } from "./support/network.ts";

// Generated histories of calls, interrupts, message deliveries, dropped
// connections and server availability, run against the real PortProtocol,
// RpcClient and RpcServer over ports whose deliveries the test controls.

const Rpcs = RpcGroup.make(
  Rpc.make("Echo", { payload: { id: Schema.Number }, success: Schema.Number }),
  Rpc.make("Hang", { payload: { id: Schema.Number } }),
  Rpc.make("Count", {
    payload: { id: Schema.Number, upTo: Schema.Number },
    success: Schema.Number,
    stream: true,
  }),
);

// --- Histories ---------------------------------------------------------------

type ServerMode = "accept" | "reject" | "absent";
type CallKind = "echo" | "hang" | "count" | "retry";

type Action =
  | { readonly _tag: "Call"; readonly kind: CallKind; readonly client: number }
  | { readonly _tag: "Interrupt"; readonly pick: number }
  | { readonly _tag: "Deliver"; readonly pick: number }
  | { readonly _tag: "DeliverAll" }
  | {
      readonly _tag: "Drop";
      readonly pick: number;
      /** Pick among connections with running handlers when there are any. */
      readonly busy: boolean;
      /** Deliver the close to the client now rather than leaving it queued. */
      readonly notify: boolean;
    }
  | { readonly _tag: "Serve"; readonly mode: ServerMode };

interface Step {
  readonly action: Action;
  /**
   * Whether to let the system go idle before the next step. Without it the
   * next action lands in the middle of whatever this one set off: a
   * reconnection, a flush of queued calls, a stream in progress.
   */
  readonly settle: boolean;
}

interface History {
  readonly initialMode: ServerMode;
  readonly steps: ReadonlyArray<Step>;
}

const anyAction: fc.Arbitrary<Action> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      _tag: fc.constant<"Call">("Call"),
      kind: fc.constantFrom<CallKind>("echo", "hang", "count", "retry"),
      client: fc.integer({ min: 0, max: 1 }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({ _tag: fc.constant<"Interrupt">("Interrupt"), pick: fc.nat() }),
  },
  { weight: 6, arbitrary: fc.record({ _tag: fc.constant<"Deliver">("Deliver"), pick: fc.nat() }) },
  // Reaches steady states (established connections, running handlers) that
  // single deliveries rarely get to before something else happens.
  { weight: 2, arbitrary: fc.record({ _tag: fc.constant<"DeliverAll">("DeliverAll") }) },
  {
    weight: 2,
    arbitrary: fc.record({
      _tag: fc.constant<"Drop">("Drop"),
      pick: fc.nat(),
      busy: fc.boolean(),
      notify: fc.boolean(),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      _tag: fc.constant<"Serve">("Serve"),
      // Refusal ends a history's interesting part, so it is rare here; the
      // unit tests cover refusal itself.
      mode: fc.oneof(
        { weight: 6, arbitrary: fc.constant<ServerMode>("accept") },
        { weight: 3, arbitrary: fc.constant<ServerMode>("absent") },
        { weight: 1, arbitrary: fc.constant<ServerMode>("reject") },
      ),
    }),
  },
);

const settle = fc.oneof(
  { weight: 3, arbitrary: fc.constant(true) },
  { weight: 1, arbitrary: fc.constant(false) },
);

const history: fc.Arbitrary<History> = fc.record({
  initialMode: fc.oneof(
    { weight: 4, arbitrary: fc.constant<ServerMode>("accept") },
    { weight: 1, arbitrary: fc.constant<ServerMode>("absent") },
  ),
  // fast-check's default size keeps arrays to about ten elements, too short
  // to establish a connection, start handlers and then drop it.
  steps: fc.array(fc.record({ action: anyAction, settle }), { maxLength: 60, size: "large" }),
});

// --- Running a history -------------------------------------------------------

type Outcome =
  | { readonly _tag: "Success"; readonly value: string }
  | { readonly _tag: "Failure"; readonly reason: string }
  | { readonly _tag: "Interrupted" };

interface Attempt {
  readonly id: number;
  readonly kind: "echo" | "hang" | "count";
  /** Started while the client was handling a dropped connection, e.g. an immediate retry. */
  readonly startedWhileHandlingDrop: boolean;
  settled: { readonly sequence: number; readonly outcome: Outcome } | undefined;
}

type Situation =
  | "handler running when its connection dropped"
  | "call started while a drop was being handled"
  | "call interrupted before it was sent"
  | "retry after a failure"
  | "reconnected after a drop"
  | "connection refused"
  | "stream completed";

interface Run {
  readonly network: Network;
  readonly attempts: ReadonlyArray<Attempt>;
  /** Handlers found running, at an idle point, after their connection's server end saw it close. */
  readonly handlersOutlivingConnection: ReadonlyArray<number>;
  /** Non-hanging calls unsettled once the server was reachable and everything was delivered. */
  readonly stuck: ReadonlyArray<number>;
  /** Handlers still running after every call was interrupted and everything was delivered. */
  readonly handlersOutlivingCalls: ReadonlyArray<number>;
  /** Calls still unsettled after every call was interrupted and everything was delivered. */
  readonly stuckAfterInterrupt: ReadonlyArray<number>;
  /** Whether the network went quiet once the server was reachable, before and after interrupting everything. */
  readonly quiet: boolean;
  /** Situations the history reached, for checking the generator's coverage. */
  readonly situations: ReadonlySet<Situation>;
}

const expectedValue = (attempt: Attempt) =>
  attempt.kind === "echo" ? String(attempt.id) : attempt.kind === "count" ? "[0,1,2]" : "done";

const outcomeOf = (exit: Exit.Exit<string, RpcClientError.RpcClientError>): Outcome => {
  if (Exit.isSuccess(exit)) return { _tag: "Success", value: exit.value };
  if (Cause.hasInterruptsOnly(exit.cause)) return { _tag: "Interrupted" };
  return Option.match(Cause.findErrorOption(exit.cause), {
    onNone: () => ({ _tag: "Failure", reason: "Defect" }),
    onSome: (error) => ({ _tag: "Failure", reason: error.reason._tag }),
  });
};

const decodeRequestPayload = Schema.decodeUnknownOption(Schema.Struct({ id: Schema.Number }));

/** Requests the client posted, by call. */
const requestPosts = (network: Network) =>
  network.clientPosts.flatMap((post) =>
    post.message._tag === "Request"
      ? Option.match(decodeRequestPayload(post.message.payload), {
          onNone: () => [],
          onSome: ({ id }) => [{ id, sequence: post.sequence, connection: post.connection }],
        })
      : [],
  );

const immediate = () => new Promise<void>((resolve) => setImmediate(resolve));

const runHistory = async ({ initialMode, steps }: History): Promise<Run> => {
  const network = new Network();
  const attempts: Array<Attempt> = [];
  const handlersStarted = new Map<number, number>();
  const handlersInterrupted = new Set<number>();
  const acceptedConnections: Array<number> = [];
  const situations = new Set<Situation>();
  const handlersOutlivingConnection = new Set<number>();
  let mode = initialMode;
  let progress = 0;

  const runningHangHandlers = () =>
    attempts.filter(
      (a) => a.kind === "hang" && handlersStarted.has(a.id) && !handlersInterrupted.has(a.id),
    );

  // Waits until nothing makes observable progress for `quietTurns` scheduler
  // turns, then checks the handler invariant, which must hold at every idle
  // point. Time is a TestClock, so retries don't wait on real timers.
  const settleSystem = async (quietTurns = 3) => {
    let seen = -1;
    for (let quiet = 0; quiet < quietTurns; ) {
      await immediate();
      const now = progress + network.activity;
      quiet = now === seen ? quiet + 1 : 0;
      seen = now;
    }
    for (const handler of runningHangHandlers()) {
      if (network.connections[handlersStarted.get(handler.id)!]!.server.sawClose) {
        handlersOutlivingConnection.add(handler.id);
      }
    }
  };

  const scope = Scope.makeUnsafe();
  const server = await Effect.runPromise(
    Effect.provideService(PortProtocol.makeServer<number>(), Scope.Scope, scope),
  );
  const started = (id: number, clientId: number) =>
    Effect.sync(() => {
      progress++;
      handlersStarted.set(id, server.metadata(clientId) ?? -1);
    });
  const handlers = Rpcs.toLayer({
    Echo: ({ id }, { client }) => Effect.as(started(id, client.id), id),
    Hang: ({ id }, { client }) =>
      started(id, client.id).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            progress++;
            handlersInterrupted.add(id);
          }),
        ),
      ),
    Count: ({ id, upTo }, { client }) =>
      Stream.unwrap(Effect.as(started(id, client.id), Stream.range(0, upTo - 1))),
  });

  const connect = Effect.acquireRelease(
    Effect.sync(() => {
      const connection = network.connect();
      const index = network.connections.length - 1;
      if (mode === "accept") {
        acceptedConnections.push(index);
        server.accept(connection.server, index);
      } else if (mode === "reject") {
        PortProtocol.reject(connection.server, "refused");
      } else {
        connection.server.close();
      }
      return connection.client;
    }),
    (port) => Effect.sync(() => port.close()),
  );

  const clients = await Effect.runPromise(
    Effect.gen(function* () {
      yield* RpcServer.make(Rpcs).pipe(
        Effect.provideService(RpcServer.Protocol, server.protocol),
        Effect.provide(handlers),
        Effect.forkScoped,
      );
      // Under a TestClock the handshake timeout never fires and retries
      // don't wait on real timers.
      const clock = yield* TestClock.make();
      const protocol = yield* PortProtocol.makeClient({
        connect,
        handshakeTimeout: "1 hour",
        retrySchedule: Schedule.forever,
      }).pipe(Effect.provideService(Clock.Clock, clock));
      const make = RpcClient.make(Rpcs).pipe(Effect.provideService(RpcClient.Protocol, protocol));
      return [yield* make, yield* make];
    }).pipe(
      Effect.provideService(Scope.Scope, scope),
      // Reconnection warnings are expected in most histories.
      Effect.provideService(References.MinimumLogLevel, "None"),
    ),
  );

  const attempt = (client: (typeof clients)[number], kind: Attempt["kind"]) =>
    Effect.suspend(() => {
      const record: Attempt = {
        id: attempts.length,
        kind,
        startedWhileHandlingDrop: network.handlingDrop,
        settled: undefined,
      };
      attempts.push(record);
      if (record.startedWhileHandlingDrop)
        situations.add("call started while a drop was being handled");
      const call =
        kind === "echo"
          ? Effect.map(client.Echo({ id: record.id }), String)
          : kind === "hang"
            ? Effect.as(client.Hang({ id: record.id }), "done")
            : client
                .Count({ id: record.id, upTo: 3 })
                .pipe(Stream.runCollect, Effect.map(JSON.stringify));
      return Effect.onExit(call, (exit) =>
        Effect.sync(() => {
          progress++;
          record.settled = { sequence: network.tick(), outcome: outcomeOf(exit) };
        }),
      );
    });

  const calls: Array<Fiber.Fiber<string, RpcClientError.RpcClientError>> = [];
  const live = () => calls.filter((fiber) => fiber.pollUnsafe() === undefined);

  // Delivers until nothing is left, or gives up after `limit` deliveries.
  // A client retrying against a server that isn't serving never goes quiet.
  const deliverAll = async (limit: number) => {
    for (let delivered = 0; delivered < limit; delivered++) {
      await settleSystem();
      const ports = network.deliverable();
      if (ports.length === 0) return true;
      ports[0]!.deliverNext();
    }
    await settleSystem();
    return network.deliverable().length === 0;
  };

  for (const step of steps) {
    const action = step.action;
    switch (action._tag) {
      case "Call": {
        const client = clients[action.client]!;
        const effect =
          action.kind === "retry"
            ? attempt(client, "echo").pipe(
                Effect.catch(() => {
                  situations.add("retry after a failure");
                  return attempt(client, "echo");
                }),
              )
            : attempt(client, action.kind);
        calls.push(Effect.runFork(effect));
        break;
      }
      case "Interrupt": {
        const running = live();
        if (running.length > 0) running[action.pick % running.length]!.interruptUnsafe();
        break;
      }
      case "Deliver": {
        const ports = network.deliverable();
        if (ports.length > 0) ports[action.pick % ports.length]!.deliverNext();
        break;
      }
      case "DeliverAll":
        await deliverAll(50);
        break;
      case "Drop": {
        const open = acceptedConnections.filter(
          (index) => !network.connections[index]!.server.closed,
        );
        const busy = open.filter((index) =>
          runningHangHandlers().some((a) => handlersStarted.get(a.id) === index),
        );
        const candidates = action.busy && busy.length > 0 ? busy : open;
        if (candidates.length === 0) break;
        const target = candidates[action.pick % candidates.length]!;
        if (busy.includes(target)) situations.add("handler running when its connection dropped");
        const connection = network.connections[target]!;
        connection.server.close();
        if (action.notify) {
          while (!connection.client.sawClose && connection.client.deliverable) {
            connection.client.deliverNext();
          }
        }
        break;
      }
      case "Serve":
        mode = action.mode;
        break;
    }
    if (step.settle) await settleSystem();
  }

  // Make the server reachable and let everything in flight arrive. With the
  // server reachable the network must go quiet.
  mode = "accept";
  const quiet = await deliverAll(2_000);
  await settleSystem(50);
  const stuck = attempts
    .filter((a) => a.kind !== "hang" && a.settled === undefined)
    .map((a) => a.id);

  for (const fiber of live()) fiber.interruptUnsafe();
  const quietAfterInterrupt = await deliverAll(2_000);
  await settleSystem(50);
  const stuckAfterInterrupt = attempts.filter((a) => a.settled === undefined).map((a) => a.id);
  const handlersOutlivingCalls = runningHangHandlers().map((a) => a.id);

  await Effect.runPromise(Scope.close(scope, Exit.void));

  const sent = new Set(requestPosts(network).map((post) => post.id));
  if (attempts.some((a) => a.settled?.outcome._tag === "Interrupted" && !sent.has(a.id))) {
    situations.add("call interrupted before it was sent");
  }
  if (
    network.drops.some((drop) => Array.from(network.established).some((c) => c > drop.connection))
  ) {
    situations.add("reconnected after a drop");
  }
  if (network.refusals.length > 0) situations.add("connection refused");
  if (attempts.some((a) => a.kind === "count" && a.settled?.outcome._tag === "Success")) {
    situations.add("stream completed");
  }

  return {
    network,
    attempts,
    handlersOutlivingConnection: Array.from(handlersOutlivingConnection),
    stuck,
    handlersOutlivingCalls,
    stuckAfterInterrupt,
    quiet: quiet && quietAfterInterrupt,
    situations,
  };
};

// --- Properties --------------------------------------------------------------

const runs = Number(process.env.PROPERTY_RUNS ?? 200);

const property = (name: string, holds: (run: Run) => void) =>
  test(
    name,
    () =>
      fc.assert(
        fc.asyncProperty(history, async (generated) => holds(await runHistory(generated))),
        { numRuns: runs },
      ),
    120_000,
  );

describe("PortProtocol properties", () => {
  property("a call is never sent after its caller saw it fail or be interrupted", (run) => {
    const posts = requestPosts(run.network);
    const lateSends = run.attempts.flatMap((attempt) => {
      const settled = attempt.settled;
      if (settled === undefined || settled.outcome._tag === "Success") return [];
      return posts
        .filter((post) => post.id === attempt.id && post.sequence > settled.sequence)
        .map(() => attempt.id);
    });
    expect(lateSends).toEqual([]);
  });

  property("a call is sent at most once", (run) => {
    const counts = new Map<number, number>();
    for (const { id } of requestPosts(run.network)) counts.set(id, (counts.get(id) ?? 0) + 1);
    expect(Array.from(counts).filter(([, count]) => count > 1)).toEqual([]);
  });

  property("a call fails only when a connection it depended on drops or is refused", (run) => {
    const posts = requestPosts(run.network);
    const unexplained = run.attempts.filter((attempt) => {
      const settled = attempt.settled;
      if (settled === undefined || settled.outcome._tag !== "Failure") return false;
      const inFlightOnDroppedConnection = run.network.drops.some(
        (drop) =>
          drop.sequence < settled.sequence &&
          posts.some(
            (post) =>
              post.id === attempt.id &&
              post.connection === drop.connection &&
              post.sequence < drop.sequence,
          ),
      );
      const refused = run.network.refusals.some((sequence) => sequence < settled.sequence);
      switch (settled.outcome.reason) {
        case "SocketCloseError":
          return !(inFlightOnDroppedConnection || attempt.startedWhileHandlingDrop);
        case "RpcClientDefect":
          return !refused;
        default:
          return true;
      }
    });
    expect(unexplained.map((a) => ({ id: a.id, outcome: a.settled?.outcome }))).toEqual([]);
  });

  property("every call settles once the server is reachable, with its own result", (run) => {
    expect(run.quiet).toBe(true);
    expect(run.stuck).toEqual([]);
    expect(run.stuckAfterInterrupt).toEqual([]);
    const wrong = run.attempts.filter(
      (a) => a.settled?.outcome._tag === "Success" && a.settled.outcome.value !== expectedValue(a),
    );
    expect(wrong.map((a) => a.id)).toEqual([]);
  });

  property("a handler runs only while its call is live on an open connection", (run) => {
    expect(run.handlersOutlivingConnection).toEqual([]);
    expect(run.handlersOutlivingCalls).toEqual([]);
  });

  // The properties above are only as strong as the histories they see. Each
  // situation is where at least one of them can fail; the floors are about
  // half of what the generator reaches today.
  test("generated histories reach the situations the properties are about", async () => {
    const counts = new Map<Situation, number>();
    for (const sample of fc.sample(history, { numRuns: 100, seed: 1 })) {
      for (const situation of (await runHistory(sample)).situations) {
        counts.set(situation, (counts.get(situation) ?? 0) + 1);
      }
    }
    const floors = [
      ["handler running when its connection dropped", 12],
      ["call started while a drop was being handled", 15],
      ["call interrupted before it was sent", 15],
      ["retry after a failure", 15],
      ["reconnected after a drop", 30],
      ["connection refused", 3],
      ["stream completed", 25],
    ] as const satisfies ReadonlyArray<readonly [Situation, number]>;
    const short = floors.filter(([situation, floor]) => (counts.get(situation) ?? 0) < floor);
    expect({ short, counts: Object.fromEntries(counts) }).toMatchObject({ short: [] });
  }, 120_000);
});
