/**
 * Effect RPC protocols over message ports.
 *
 * A message port is an ordered, bidirectional pipe between two JavaScript
 * contexts that copies messages with the structured clone algorithm. That is
 * everything `RpcServer.Protocol` and `RpcClient.Protocol` need:
 *
 * - `RpcMessage` envelopes are already schema-encoded, so they are posted as
 *   they are, with no `RpcSerialization` step.
 * - One port is one connection, so a closed port is a disconnected client and
 *   the server interrupts everything that client had in flight.
 * - Ports preserve message order, so stream acknowledgements give real
 *   backpressure across the boundary.
 *
 * The Electron entry points build on this module. It is exported for custom
 * topologies such as ports handed between renderers or into web workers.
 *
 * @since 1.0.0
 */
import { Deferred, Duration, Effect, FiberSet, Predicate, Queue, Schedule, Schema } from "effect";
import type { Fiber, Scope } from "effect";
import { RpcClient, RpcClientError, RpcMessage, RpcServer } from "effect/unstable/rpc";
import { Socket } from "effect/unstable/socket";
import { rejection } from "./internal/connect.ts";

/**
 * The minimal port surface the protocols need. Adapters exist for DOM
 * `MessagePort` ({@link fromMessagePort}) and Electron `MessagePortMain`
 * (`fromMessagePortMain` in the main and utility entry points).
 *
 * @category models
 * @since 1.0.0
 */
export interface Port {
  readonly postMessage: (
    message: RpcMessage.FromClientEncoded | RpcMessage.FromServerEncoded,
  ) => void;
  /** Installs the listeners and starts delivery of queued messages. */
  readonly start: (listeners: PortListeners) => void;
  readonly close: () => void;
}

/**
 * @category models
 * @since 1.0.0
 */
export interface PortListeners {
  readonly onMessage: (event: PortMessageEvent) => void;
  /** Called once the other side of the port is gone. */
  readonly onClose: () => void;
}

/**
 * A received message before it has been validated.
 *
 * @category models
 * @since 1.0.0
 */
export interface PortMessageEvent {
  readonly data: unknown;
}

/**
 * Adapts a DOM `MessagePort` (renderer main world, preload, web workers).
 *
 * @category constructors
 * @since 1.0.0
 */
export const fromMessagePort = (port: MessagePort): Port => ({
  postMessage: (message) => port.postMessage(message),
  start: ({ onMessage, onClose }) => {
    port.addEventListener("message", onMessage);
    port.addEventListener("close", onClose, { once: true });
    port.start();
  },
  close: () => port.close(),
});

// Wire validation. Only the envelope is checked here: payloads, chunks, exits
// and defects are decoded against the RPC's own schemas by RpcServer and
// RpcClient, which also report failures for the individual request.

const RequestId = Schema.Union([Schema.String, Schema.Number]);

const FromClientWire = Schema.Union([
  Schema.Struct({
    _tag: Schema.tag("Request"),
    id: RequestId,
    tag: Schema.String,
    payload: Schema.Unknown,
    headers: Schema.Array(Schema.mutable(Schema.Tuple([Schema.String, Schema.String]))),
    isNotification: Schema.optionalKey(Schema.Literal(true)),
    traceId: Schema.optionalKey(Schema.String),
    spanId: Schema.optionalKey(Schema.String),
    sampled: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({ _tag: Schema.tag("Ack"), requestId: RequestId }),
  Schema.Struct({ _tag: Schema.tag("Interrupt"), requestId: RequestId }),
  Schema.Struct({ _tag: Schema.tag("Ping") }),
  Schema.Struct({ _tag: Schema.tag("Eof") }),
]);

const isFromClientEncoded = Schema.is(FromClientWire);

// Interrupt fiber ids arrive as `null` although `ExitEncoded` types them as
// `number | undefined`, so the exit is declared opaquely and left for
// RpcClient's exit schema to decode.
const ExitEncoded = Schema.declare(
  (input): input is RpcMessage.ExitEncoded<unknown, unknown> =>
    (Predicate.isTagged(input, "Success") && Predicate.hasProperty(input, "value")) ||
    (Predicate.isTagged(input, "Failure") &&
      Predicate.hasProperty(input, "cause") &&
      Array.isArray(input.cause)),
);

const FromServerWire = Schema.Union([
  Schema.Struct({
    _tag: Schema.tag("Chunk"),
    requestId: RequestId,
    values: Schema.NonEmptyArray(Schema.Unknown),
  }),
  Schema.Struct({ _tag: Schema.tag("Exit"), requestId: RequestId, exit: ExitEncoded }),
  Schema.Struct({ _tag: Schema.tag("Defect"), defect: Schema.Unknown }),
  Schema.Struct({ _tag: Schema.tag("Pong") }),
]);

type FromServerWire = typeof FromServerWire.Type;

const isFromServerEncoded = Schema.is(FromServerWire);

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/**
 * Refuses a connection instead of accepting it. The client fails its pending
 * and future calls with `reason` rather than reconnecting.
 *
 * @category constructors
 * @since 1.0.0
 */
export const reject = (port: Port, reason: string): void => {
  port.postMessage(rejection(reason));
  port.close();
};

/**
 * @category models
 * @since 1.0.0
 */
export interface PortServer<Metadata> {
  readonly protocol: RpcServer.Protocol["Service"];
  /**
   * Accepts a port as a new client. The client is disconnected when the port
   * closes. Safe to call from plain callbacks such as IPC listeners.
   */
  readonly accept: (port: Port, metadata: Metadata) => void;
  /** The metadata a connected client was accepted with. */
  readonly metadata: (clientId: number) => Metadata | undefined;
}

interface ServerConnection<Metadata> {
  readonly port: Port;
  readonly metadata: Metadata;
  readonly fiber: Fiber.Fiber<never>;
}

/**
 * Creates an `RpcServer.Protocol` that serves any number of port connections.
 *
 * Messages from each port are handed to the server in arrival order, so an
 * `Interrupt` or `Ack` can never overtake the request it refers to.
 *
 * @category constructors
 * @since 1.0.0
 */
export const makeServer = <Metadata>(): Effect.Effect<PortServer<Metadata>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const runFork = yield* FiberSet.makeRuntime<never, never, never>();
    const disconnects = yield* Queue.unbounded<number>();
    const connections = new Map<number, ServerConnection<Metadata>>();
    let nextClientId = 0;
    let isShutdown = false;

    let writeRequest = (_clientId: number, _message: RpcMessage.FromClientEncoded) => Effect.void;

    const protocol = yield* RpcServer.Protocol.make((write) => {
      writeRequest = write;
      return Effect.succeed({
        disconnects,
        send: (clientId, response) =>
          Effect.sync(() => connections.get(clientId)?.port.postMessage(response)),
        end: () => Effect.void,
        clientIds: Effect.sync(() => new Set(connections.keys())),
        initialMessage: Effect.succeedNone,
        supportsAck: true,
        supportsTransferables: false,
        supportsSpanPropagation: true,
      });
    });

    const disconnect = (clientId: number) => {
      const connection = connections.get(clientId);
      if (connection === undefined) return;
      connections.delete(clientId);
      connection.fiber.interruptUnsafe();
      Queue.offerUnsafe(disconnects, clientId);
    };

    const accept = (port: Port, metadata: Metadata) => {
      if (isShutdown) {
        port.close();
        return;
      }
      const clientId = nextClientId++;
      const fiber = runFork(
        Effect.gen(function* () {
          const mailbox = yield* Queue.unbounded<RpcMessage.FromClientEncoded>();
          port.start({
            onMessage: (event) => {
              if (isFromClientEncoded(event.data)) {
                Queue.offerUnsafe(mailbox, event.data);
              }
            },
            onClose: () => disconnect(clientId),
          });
          return yield* Effect.forever(
            Effect.flatMap(Queue.take(mailbox), (message) => writeRequest(clientId, message)),
          );
        }),
      );
      connections.set(clientId, { port, metadata, fiber });
    };

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        isShutdown = true;
        const open = Array.from(connections.values());
        connections.clear();
        for (const connection of open) {
          connection.port.close();
        }
      }),
    );

    return {
      protocol,
      accept,
      metadata: (clientId) => connections.get(clientId)?.metadata,
    } satisfies PortServer<Metadata>;
  });

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * @category models
 * @since 1.0.0
 */
export interface ClientOptions {
  /**
   * Opens a new connection. Run once initially and again after every
   * disconnect; the scope closes when that connection is abandoned.
   */
  readonly connect: Effect.Effect<Port, RpcClientError.RpcClientError, Scope.Scope>;
  /** Names the remote side in log messages and errors. */
  readonly name?: string | undefined;
  /** How long to wait for the server to answer the handshake. Defaults to 5 seconds. */
  readonly handshakeTimeout?: Duration.Input | undefined;
  /**
   * Controls reconnection after failed or dropped connections. When it stops
   * recurring, pending and future requests fail with the last error. Retries
   * forever by default, backing off from 100ms up to 2 seconds.
   */
  readonly retrySchedule?: Schedule.Schedule<unknown, RpcClientError.RpcClientError> | undefined;
}

const defaultHandshakeTimeout = Duration.seconds(5);

/**
 * @category constants
 * @since 1.0.0
 */
export const defaultRetrySchedule: Schedule.Schedule<Duration.Duration> = Schedule.min([
  Schedule.exponential(100, 2),
  Schedule.spaced(2000),
]);

const handshakeTimeoutError = (name: string, timeout: Duration.Duration) =>
  new RpcClientError.RpcClientError({
    reason: new Socket.SocketOpenError({
      kind: "Timeout",
      cause: new Error(
        `${name} did not answer the RPC handshake within ${Duration.format(timeout)}. ` +
          "The server may not be running, or the port was never delivered to it.",
      ),
    }),
  });

const closedDuringHandshakeError = (name: string) =>
  new RpcClientError.RpcClientError({
    reason: new Socket.SocketOpenError({
      kind: "Unknown",
      cause: new Error(
        `${name} closed the connection during the RPC handshake. ` +
          "Nothing is serving it yet, or its server is shutting down.",
      ),
    }),
  });

const closedError = (name: string) =>
  new RpcClientError.RpcClientError({
    reason: new Socket.SocketCloseError({
      code: 1006,
      closeReason: `${name} closed the RPC connection`,
    }),
  });

const rejectedError = (name: string, cause: unknown) =>
  new RpcClientError.RpcClientError({
    reason: new RpcClientError.RpcClientDefect({
      message: `${name} rejected the RPC connection`,
      cause,
    }),
  });

const postError = (cause: unknown) =>
  new RpcClientError.RpcClientError({
    reason: new RpcClientError.RpcClientDefect({
      message: "Failed to post an RPC message to the port",
      cause,
    }),
  });

/**
 * Creates an `RpcClient.Protocol` over a port obtained from `connect`.
 *
 * Connection semantics:
 *
 * - The connection is established with a `Ping`/`Pong` handshake. Requests
 *   made before it completes are queued and sent once it does.
 * - If an established connection drops, requests that were in flight fail
 *   with an `RpcClientError` (`SocketCloseError`), because the server may or
 *   may not have run them. The client then reconnects.
 * - Failed connection attempts are retried with `retrySchedule` while requests
 *   stay queued. Interrupting a queued request removes it from the queue.
 * - A connection refused with {@link reject} is not retried: pending and
 *   future requests fail with an `RpcClientDefect` carrying the reason.
 *
 * @category constructors
 * @since 1.0.0
 */
export const makeClient = (
  options: ClientOptions,
): Effect.Effect<RpcClient.Protocol["Service"], never, Scope.Scope> =>
  RpcClient.Protocol.make(
    Effect.fnUntraced(function* (writeResponse, clientIds) {
      const runFork = yield* FiberSet.makeRuntime<never, void, never>();
      const name = options.name ?? "The RPC server";
      const handshakeTimeout = Duration.fromInputUnsafe(
        options.handshakeTimeout ?? defaultHandshakeTimeout,
      );
      const requestClients = new Map<string | number, number>();
      let connected: Port | undefined;
      let queued: Array<RpcMessage.FromClientEncoded> = [];
      let permanentError: RpcClientError.RpcClientError | undefined;
      // Set while a failure is being delivered. RpcClient fails every request
      // it knows about during that delivery, including ones started by
      // callers resuming synchronously from their own failure, so those must
      // not be queued for a later connection. Remove once RpcClient stops
      // iterating its live request map:
      // https://github.com/Effect-TS/effect/issues/8600
      // After that fix this guard would fail those calls itself.
      let failing: RpcClientError.RpcClientError | undefined;
      let rejected = false;

      const broadcast = (message: RpcMessage.FromServerEncoded) =>
        Effect.forEach(clientIds, (clientId) => writeResponse(clientId, message), {
          discard: true,
        });

      // Everything registered with RpcClient fails, so nothing may be sent
      // for those requests later.
      const failAll = (error: RpcClientError.RpcClientError) =>
        Effect.suspend(() => {
          connected = undefined;
          queued = [];
          requestClients.clear();
          failing = error;
          return broadcast({ _tag: "ClientProtocolError", error });
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              failing = undefined;
            }),
          ),
        );

      const route = (message: Exclude<FromServerWire, { readonly _tag: "Pong" }>) => {
        if (message._tag === "Defect") {
          runFork(broadcast(message));
          return;
        }
        const clientId = requestClients.get(message.requestId);
        if (clientId === undefined) return;
        if (message._tag === "Exit") {
          requestClients.delete(message.requestId);
        }
        runFork(writeResponse(clientId, message));
      };

      const connection = Effect.gen(function* () {
        const port = yield* options.connect;
        const opened = Deferred.makeUnsafe<void, RpcClientError.RpcClientError>();
        const closed = Deferred.makeUnsafe<void>();
        port.start({
          onMessage: (event) => {
            if (!isFromServerEncoded(event.data)) return;
            const message = event.data;
            if (message._tag === "Pong") {
              Deferred.doneUnsafe(opened, Effect.void);
            } else if (message._tag === "Defect" && !Deferred.isDoneUnsafe(opened)) {
              rejected = true;
              Deferred.doneUnsafe(opened, Effect.fail(rejectedError(name, message.defect)));
            } else {
              route(message);
            }
          },
          onClose: () => {
            if (connected === port) connected = undefined;
            Deferred.doneUnsafe(closed, Effect.void);
          },
        });
        port.postMessage(RpcMessage.constPing);

        yield* Deferred.await(opened).pipe(
          Effect.raceFirst(
            Effect.andThen(Deferred.await(closed), Effect.fail(closedDuringHandshakeError(name))),
          ),
          Effect.timeoutOrElse({
            duration: handshakeTimeout,
            orElse: () => Effect.fail(handshakeTimeoutError(name, handshakeTimeout)),
          }),
        );

        connected = port;
        const backlog = queued;
        queued = [];
        for (const message of backlog) {
          port.postMessage(message);
        }

        yield* Deferred.await(closed);
        const error = closedError(name);
        yield* failAll(error);
        return yield* Effect.fail(error);
      }).pipe(
        Effect.scoped,
        Effect.tapError((error) =>
          rejected
            ? Effect.void
            : Effect.logWarning(`RPC connection to ${name} failed; reconnecting`, error),
        ),
      );

      const retrySchedule = options.retrySchedule ?? defaultRetrySchedule;
      yield* connection.pipe(
        Effect.retry(Schedule.while(retrySchedule, () => !rejected)),
        Effect.catch((error) =>
          Effect.suspend(() => {
            permanentError = error;
            return Effect.andThen(
              Effect.logError(`RPC connection to ${name} failed permanently`, error),
              failAll(error),
            );
          }),
        ),
        Effect.annotateLogs({ module: "electron-effect-rpc/PortProtocol" }),
        Effect.forkScoped,
      );

      const enqueue = (message: RpcMessage.FromClientEncoded) => {
        if (message._tag === "Interrupt") {
          const index = queued.findIndex(
            (pending) => pending._tag === "Request" && pending.id === message.requestId,
          );
          if (index !== -1) {
            queued.splice(index, 1);
            requestClients.delete(message.requestId);
            return;
          }
        }
        queued.push(message);
      };

      return {
        send: (clientId, message) => {
          const error = permanentError ?? failing;
          if (error !== undefined) return Effect.fail(error);
          if (message._tag === "Request") {
            requestClients.set(message.id, clientId);
          }
          const port = connected;
          if (port === undefined) {
            enqueue(message);
            return Effect.void;
          }
          return Effect.try({
            try: () => port.postMessage(message),
            catch: (cause) => {
              if (message._tag === "Request") requestClients.delete(message.id);
              return postError(cause);
            },
          });
        },
        supportsAck: true,
        supportsTransferables: false,
      };
    }),
  );
