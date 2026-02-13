import type * as Effect from "effect/Effect";
import type * as Runtime from "effect/Runtime";
import type {
  AnyEvent,
  AnyMethod,
  ErrorSchema,
  ExtractMethod,
  RpcContract,
  RpcError,
  RpcEvent,
  RpcEventPayload,
  RpcInput,
  RpcMethod,
  RpcOutput,
  SchemaNoContext,
} from "./contract.ts";

export type {
  AnyEvent,
  AnyMethod,
  ErrorSchema,
  ExtractMethod,
  RpcContract,
  RpcError,
  RpcEvent,
  RpcEventPayload,
  RpcInput,
  RpcMethod,
  RpcOutput,
  SchemaNoContext,
} from "./contract.ts";

export type Implementations<
  C extends RpcContract<readonly AnyMethod[], readonly AnyEvent[]>,
  R = never
> = {
  readonly [Name in C["methods"][number]["name"]]: (
    input: RpcInput<ExtractMethod<C["methods"], Name>>
  ) => Effect.Effect<
    RpcOutput<ExtractMethod<C["methods"], Name>>,
    RpcError<ExtractMethod<C["methods"], Name>>,
    R
  >;
};

type IsEmptyObject<T> = T extends object
  ? keyof T extends never
    ? true
    : false
  : false;

export type RpcCaller<M extends AnyMethod> =
  IsEmptyObject<RpcInput<M>> extends true
    ? () => Promise<RpcOutput<M>>
    : (input: RpcInput<M>) => Promise<RpcOutput<M>>;

export type RpcClient<
  C extends RpcContract<readonly AnyMethod[], readonly AnyEvent[]>
> = {
  readonly [Name in C["methods"][number]["name"]]: RpcCaller<
    ExtractMethod<C["methods"], Name>
  >;
};

export class RpcDefectError extends Error {
  readonly _tag = "RpcDefectError";

  constructor(
    message: string,
    public readonly cause: unknown
  ) {
    super(message);
    this.name = "RpcDefectError";
  }
}

export type ChannelPrefix = {
  readonly rpc: string;
  readonly event: string;
};

export const defaultChannelPrefix: ChannelPrefix = {
  rpc: "rpc/",
  event: "event/",
};

export type DecodeFailureScope = "rpc-request" | "rpc-response" | "event-payload";

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
    listener: (event: unknown, payload: unknown) => unknown
  ) => unknown;
  readonly removeHandler: (channel: string) => unknown;
};

export interface RpcEndpoint {
  readonly start: () => void;
  readonly stop: () => void;
  readonly dispose: () => void;
  readonly isRunning: () => boolean;
}

/**
 * Runtime used to execute handler effects.
 */
export type RpcEndpointOptions<R = never> = {
  readonly channelPrefix?: ChannelPrefix;
  readonly runtime: Runtime.Runtime<R>;
  readonly diagnostics?: RpcEndpointDiagnostics;
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
  readonly getWindow: () => RendererWindowLike | null;
  readonly maxQueueSize?: number;
  readonly diagnostics?: EventPublisherDiagnostics;
};

export interface RpcEventPublisher<
  C extends RpcContract<readonly AnyMethod[], readonly AnyEvent[]>
> {
  readonly publish: <E extends C["events"][number]>(
    event: E,
    payload: RpcEventPayload<E>
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

export type EventSubscribe = (
  name: string,
  handler: (payload: unknown) => void
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
  C extends RpcContract<readonly AnyMethod[], readonly AnyEvent[]>
> {
  readonly subscribe: <E extends C["events"][number]>(
    event: E,
    handler: (payload: RpcEventPayload<E>) => void
  ) => () => void;
  readonly subscribeByName: (
    name: string,
    handler: (payload: unknown) => void
  ) => () => void;
  readonly dispose: () => void;
}

export type {
  IpcBridge,
  IpcBridgeGlobal,
  IpcKit,
  IpcKitOptions,
  IpcMainHandle,
} from "./kit.ts";
