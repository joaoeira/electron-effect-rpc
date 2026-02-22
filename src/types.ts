import type * as Effect from "effect/Effect";
import type * as Runtime from "effect/Runtime";
import type * as Stream from "effect/Stream";
import type {
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

export type Implementations<
  C extends RpcContract<readonly AnyMethod[], readonly AnyEvent[], readonly AnyStreamMethod[]>,
  R = never,
> = {
  readonly [Name in C["methods"][number]["name"]]: (
    input: RpcInput<ExtractMethod<C["methods"], Name>>,
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
  ) => Stream.Stream<
    StreamChunk<ExtractStreamMethod<C["streamMethods"], Name>>,
    StreamError<ExtractStreamMethod<C["streamMethods"], Name>>,
    R
  >;
};

export type WebContentsLike = {
  readonly id: number;
  readonly isDestroyed: () => boolean;
  readonly send: (channel: string, payload: unknown) => void;
};

type IsEmptyObject<T> = T extends object ? (keyof T extends never ? true : false) : false;

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
  readonly payload: unknown;
  readonly cause: unknown;
};

export type ProtocolErrorContext = {
  readonly method: string;
  readonly response: unknown;
  readonly cause: unknown;
};

export type DispatchFailureContext = {
  readonly event: string;
  readonly payload: unknown;
  readonly cause: unknown;
};

export type DroppedEventReason =
  | "queue_full"
  | "encoding_failed"
  | "window_unavailable"
  | "dispatch_failed";

export type DroppedEventContext = {
  readonly event: string;
  readonly payload: unknown;
  readonly reason: DroppedEventReason;
  readonly queued: number;
  readonly dropped: number;
};

export type RpcInvoke = (method: string, payload: unknown) => Promise<unknown>;

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

export type IpcMainLike = {
  readonly handle: (
    channel: string,
    listener: (event: unknown, payload: unknown) => unknown,
  ) => unknown;
  readonly removeHandler: (channel: string) => unknown;
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
  readonly runtime: Runtime.Runtime<R>;
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
    readonly send: (channel: string, payload: unknown) => void;
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
  readonly publish: <E extends C["events"][number]>(
    event: E,
    payload: RpcEventPayload<E>,
  ) => Effect.Effect<void, never>;
  readonly start: () => void;
  readonly stop: () => void;
  readonly dispose: () => void;
  readonly isRunning: () => boolean;
  readonly stats: () => {
    readonly queued: number;
    readonly dropped: number;
  };
}

export type EventDecodeMode = "safe" | "strict";

export type EventSubscribe = (name: string, handler: (payload: unknown) => void) => () => void;

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
  readonly subscribeByName: (name: string, handler: (payload: unknown) => void) => () => void;
  readonly dispose: () => void;
}

export type OnStreamFrame = (listener: (frame: unknown) => void) => () => void;

export type StreamRpcClientOptions = {
  readonly invoke: RpcInvoke;
  readonly onStreamFrame: OnStreamFrame;
  readonly diagnostics?: RpcClientDiagnostics;
};

export interface StreamRpcClientHandle<
  C extends RpcContract<readonly AnyMethod[], readonly AnyEvent[], readonly AnyStreamMethod[]>,
> {
  readonly client: StreamRpcClient<C>;
  readonly dispose: () => void;
}

export type { IpcBridge, IpcBridgeGlobal, IpcKit, IpcKitOptions, IpcMainHandle } from "./kit.ts";
