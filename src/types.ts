import type * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type { DiagnosticCause, IpcEncodedValue } from "./boundary.ts";
import type {
  AnyEvent,
  AnyMethod,
  AnyStreamMethod,
  ExtractMethod,
  ExtractStreamMethod,
  RpcContract,
  RpcError,
  RpcEventPayload,
  RpcInput,
  RpcOutput,
  StreamChunk,
  StreamError,
  StreamInput,
} from "./contract.ts";

export type {
  AnyEvent,
  AnyMethod,
  AnyStreamMethod,
  ErrorSchema,
  ExtractMethod,
  ExtractStreamMethod,
  RpcContract,
  RpcError,
  RpcEvent,
  RpcEventPayload,
  RpcInput,
  RpcMethod,
  RpcOutput,
  SchemaNoContext,
  StreamChunk,
  StreamError,
  StreamInput,
  StreamRpcMethod,
} from "./contract.ts";

/**
 * Per-request context passed as the second argument to handlers.
 * Handlers that don't need it can simply omit the parameter.
 */
export type RpcHandlerContext = {
  /** The webContents that sent the request, when the transport exposes it. */
  readonly sender: WebContentsLike | null;
};

export type Implementations<
  C extends RpcContract<readonly AnyMethod[], readonly AnyEvent[], readonly AnyStreamMethod[]>,
  R = never,
> = {
  readonly [Name in C["methods"][number]["name"]]: (
    input: RpcInput<ExtractMethod<C["methods"], Name>>,
    context: RpcHandlerContext,
  ) => Effect.Effect<
    RpcOutput<ExtractMethod<C["methods"], Name>>,
    RpcError<ExtractMethod<C["methods"], Name>>,
    R
  >;
};

export type StreamImplementations<
  C extends RpcContract<readonly AnyMethod[], readonly AnyEvent[], readonly AnyStreamMethod[]>,
  R = never,
> = {
  readonly [Name in C["streamMethods"][number]["name"]]: (
    input: StreamInput<ExtractStreamMethod<C["streamMethods"], Name>>,
    context: RpcHandlerContext,
  ) => Stream.Stream<
    StreamChunk<ExtractStreamMethod<C["streamMethods"], Name>>,
    StreamError<ExtractStreamMethod<C["streamMethods"], Name>>,
    R
  >;
};

export type WebContentsLike = {
  readonly id: number;
  readonly isDestroyed: () => boolean;
  readonly send: (channel: string, payload: IpcEncodedValue) => void;
  /**
   * Optional EventEmitter surface (present on real Electron WebContents).
   * When available, active stream fibers are interrupted as soon as the
   * renderer is destroyed; otherwise termination happens on the next chunk.
   */
  readonly once?: (event: "destroyed", listener: () => void) => void;
  readonly removeListener?: (event: "destroyed", listener: () => void) => void;
};

export type IpcInvokeEvent = {
  readonly sender?: WebContentsLike;
};

// True only for exactly `{}` (e.g. S.Struct({})). `string extends T`
// distinguishes `{}` (accepts primitives) from `object` (does not), so
// methods with an `object`-typed input still require an argument.
type IsEmptyObject<T> = T extends object
  ? keyof T extends never
    ? string extends T
      ? true
      : false
    : false
  : false;

export type RpcDefectCode =
  | "request_encoding_failed"
  | "invoke_failed"
  | "success_payload_decoding_failed"
  | "failure_payload_decoding_failed"
  | "noerror_contract_violation"
  | "invalid_response_envelope"
  | "legacy_decode_failed"
  | "remote_defect"
  | "stream_invoke_failed"
  | "stream_handshake_invalid"
  | "stream_chunk_decode_failed"
  | "stream_error_decode_failed";

export class RpcDefectError extends Error {
  readonly _tag = "RpcDefectError";

  constructor(
    public readonly code: RpcDefectCode,
    message: string,
    public readonly cause: unknown,
  ) {
    super(message);
    this.name = "RpcDefectError";
  }
}

export type RpcMethodError<M extends AnyMethod> = RpcError<M> | RpcDefectError;

export type RpcCaller<M extends AnyMethod> =
  IsEmptyObject<RpcInput<M>> extends true
    ? () => Effect.Effect<RpcOutput<M>, RpcMethodError<M>>
    : (input: RpcInput<M>) => Effect.Effect<RpcOutput<M>, RpcMethodError<M>>;

export type RpcClient<
  C extends RpcContract<readonly AnyMethod[], readonly AnyEvent[], readonly AnyStreamMethod[]>,
> = {
  readonly [Name in C["methods"][number]["name"]]: RpcCaller<ExtractMethod<C["methods"], Name>>;
};

export type StreamMethodError<M extends AnyStreamMethod> = StreamError<M> | RpcDefectError;

export type StreamRpcCaller<M extends AnyStreamMethod> =
  IsEmptyObject<StreamInput<M>> extends true
    ? () => Stream.Stream<StreamChunk<M>, StreamMethodError<M>>
    : (input: StreamInput<M>) => Stream.Stream<StreamChunk<M>, StreamMethodError<M>>;

export type StreamRpcClient<
  C extends RpcContract<readonly AnyMethod[], readonly AnyEvent[], readonly AnyStreamMethod[]>,
> = {
  readonly [Name in C["streamMethods"][number]["name"]]: StreamRpcCaller<
    ExtractStreamMethod<C["streamMethods"], Name>
  >;
};

export type ChannelPrefix = {
  readonly rpc: string;
  readonly event: string;
};

export const defaultChannelPrefix: ChannelPrefix = {
  rpc: "rpc/",
  event: "event/",
};

/**
 * RPC and event prefixes must differ: with identical prefixes an event named
 * like a method (or named "sf"/"stream-cancel") would collide with RPC and
 * stream transport channels.
 */
export function assertValidChannelPrefix(prefix: ChannelPrefix): ChannelPrefix {
  if (prefix.rpc === prefix.event) {
    throw new Error(
      `channelPrefix.rpc and channelPrefix.event must differ (both were "${prefix.rpc}").`,
    );
  }
  return prefix;
}

export type DecodeFailureScope =
  | "rpc-request"
  | "rpc-response"
  | "event-payload"
  | "stream-request"
  | "stream-chunk"
  | "stream-error";

export type DecodeFailureContext = {
  readonly scope: DecodeFailureScope;
  readonly name: string;
  readonly payload: DiagnosticCause;
  readonly cause: DiagnosticCause;
};

export type ProtocolErrorContext = {
  readonly method: string;
  readonly response: DiagnosticCause;
  readonly cause: DiagnosticCause;
};

export type DispatchFailureContext = {
  readonly event: string;
  readonly payload: DiagnosticCause;
  readonly cause: DiagnosticCause;
};

export type DroppedEventReason =
  | "queue_full"
  | "encoding_failed"
  | "window_unavailable"
  | "dispatch_failed";

export type DroppedEventContext = {
  readonly event: string;
  readonly payload: DiagnosticCause;
  readonly reason: DroppedEventReason;
  readonly queued: number;
  readonly dropped: number;
};

export type RpcInvoke = (method: string, payload: IpcEncodedValue) => Promise<IpcEncodedValue>;

export type RpcResponseDecodeMode = "envelope" | "dual";

export type RpcClientDiagnostics = {
  readonly onDecodeFailure?: (context: DecodeFailureContext) => void;
  readonly onProtocolError?: (context: ProtocolErrorContext) => void;
};

export type RpcClientOptions = {
  readonly invoke: RpcInvoke;
  readonly diagnostics?: RpcClientDiagnostics;
  readonly rpcDecodeMode?: RpcResponseDecodeMode;
};

export type RpcEndpointDiagnostics = {
  readonly onDecodeFailure?: (context: DecodeFailureContext) => void;
  readonly onProtocolError?: (context: ProtocolErrorContext) => void;
};

export type IpcInvokeResult = IpcEncodedValue | Promise<IpcEncodedValue>;

export type IpcMainLike = {
  readonly handle: (
    channel: string,
    listener: (event: IpcInvokeEvent, payload: IpcEncodedValue) => IpcInvokeResult,
  ) => void;
  readonly removeHandler: (channel: string) => void;
};

export interface RpcEndpoint {
  readonly start: () => void;
  readonly stop: () => void;
  readonly dispose: () => void;
  readonly isRunning: () => boolean;
}

export type RpcEndpointOptions<
  C extends RpcContract<readonly AnyMethod[], readonly AnyEvent[], readonly AnyStreamMethod[]> =
    RpcContract<readonly AnyMethod[], readonly AnyEvent[], readonly []>,
  R = never,
> = {
  readonly channelPrefix?: ChannelPrefix;
  readonly context: Context.Context<R>;
  readonly diagnostics?: RpcEndpointDiagnostics;
  readonly streamHandlers?: StreamImplementations<C, R>;
};

export type EventPublisherDiagnostics = {
  readonly onDecodeFailure?: (context: DecodeFailureContext) => void;
  readonly onDispatchFailure?: (context: DispatchFailureContext) => void;
  readonly onDroppedEvent?: (context: DroppedEventContext) => void;
};

export type RendererWindowLike = {
  readonly isDestroyed: () => boolean;
  readonly webContents: {
    readonly send: (channel: string, payload: IpcEncodedValue) => void;
  };
};

export type EventPublisherOptions = {
  readonly channelPrefix?: ChannelPrefix;
  readonly getWindows: () => ReadonlyArray<RendererWindowLike>;
  readonly maxQueueSize?: number;
  readonly diagnostics?: EventPublisherDiagnostics;
};

export interface RpcEventPublisher<
  C extends RpcContract<readonly AnyMethod[], readonly AnyEvent[], readonly AnyStreamMethod[]>,
> {
  /**
   * Enqueue an event for delivery. Never fails: after `dispose()` the event
   * is silently discarded, and delivery problems surface only through the
   * diagnostics hooks and `stats()`.
   */
  readonly publish: <E extends C["events"][number]>(
    event: E,
    payload: RpcEventPayload<E>,
  ) => Effect.Effect<void, never>;
  readonly start: () => void;
  readonly stop: () => void;
  readonly dispose: () => void;
  readonly isRunning: () => boolean;
  /**
   * `dropped` counts failed deliveries, not whole events: an event that
   * reaches two of three windows increments it once (per failed window),
   * as do queue evictions and encoding failures.
   */
  readonly stats: () => EventPublisherStats;
}

export type EventDecodeMode = "safe" | "strict";

export type EventPublisherStats = {
  readonly queued: number;
  readonly dropped: number;
};

export type EventSubscribe = (
  name: string,
  handler: (payload: IpcEncodedValue) => void,
) => () => void;

export type EventSubscriberDiagnostics = {
  readonly onDecodeFailure?: (context: DecodeFailureContext) => void;
};

export type EventSubscriberOptions = {
  readonly subscribe: EventSubscribe;
  readonly decodeMode?: EventDecodeMode;
  readonly diagnostics?: EventSubscriberDiagnostics;
};

export interface EventSubscriber<
  C extends RpcContract<readonly AnyMethod[], readonly AnyEvent[], readonly AnyStreamMethod[]>,
> {
  readonly subscribe: <E extends C["events"][number]>(
    event: E,
    handler: (payload: RpcEventPayload<E>) => void,
  ) => () => void;
  readonly subscribeByName: (
    name: string,
    handler: (payload: IpcEncodedValue) => void,
  ) => () => void;
  /**
   * Effect-native subscription: a Stream of decoded payloads that
   * subscribes when run and unsubscribes when its scope closes.
   * Payloads that fail to decode are skipped (reported via diagnostics).
   */
  readonly stream: <E extends C["events"][number]>(event: E) => Stream.Stream<RpcEventPayload<E>>;
  readonly dispose: () => void;
}

export type OnStreamFrame = (listener: (frame: IpcEncodedValue) => void) => () => void;

/**
 * Stream chunk buffering policy in the renderer.
 * Prefer `bufferSize: "unbounded"` for lossless streams such as token deltas.
 *
 * Bounded buffers are lossy for chunks. Effect v4's callback queue still
 * preserves terminal completion and failure signals.
 */
export type StreamBufferOptions =
  | { readonly bufferSize: "unbounded" }
  | {
      readonly bufferSize: number;
      readonly strategy: "dropping" | "sliding";
    };

export type StreamRpcClientOptions = {
  readonly invoke: RpcInvoke;
  readonly onStreamFrame: OnStreamFrame;
  readonly diagnostics?: RpcClientDiagnostics;
  readonly streamBuffer?: StreamBufferOptions;
};

export interface StreamRpcClientHandle<
  C extends RpcContract<readonly AnyMethod[], readonly AnyEvent[], readonly AnyStreamMethod[]>,
> {
  readonly client: StreamRpcClient<C>;
  readonly dispose: () => void;
}

export type { DiagnosticCause, IpcEncodedRecord, IpcEncodedValue } from "./boundary.ts";

export type { IpcBridge, IpcBridgeGlobal, IpcKit, IpcKitOptions, IpcMainHandle } from "./kit.ts";
