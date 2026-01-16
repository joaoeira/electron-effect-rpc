import type * as Effect from "effect/Effect";
import type * as Runtime from "effect/Runtime";
import type { BrowserWindow } from "electron";
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

type IsEmptyObject<T> = keyof T extends never ? true : false;

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

export type IpcMainLike = {
  readonly handle: (
    channel: string,
    listener: (event: unknown, payload: unknown) => unknown
  ) => unknown;
};

export type RpcInvoke = (method: string, payload: unknown) => Promise<unknown>;

/** Provide a Runtime when handlers require services (R). */
export type RpcServerOptions<R = never> = {
  readonly channelPrefix?: ChannelPrefix;
  readonly runtime?: Runtime.Runtime<R>;
};

export type RpcClientOptions = {
  readonly invoke?: RpcInvoke;
  readonly channelPrefix?: ChannelPrefix;
};

export type EventBusOptions = {
  readonly channelPrefix?: ChannelPrefix;
  readonly getWindow: () => BrowserWindow | null;
};

export type EventSubscriberOptions = {
  readonly channelPrefix?: ChannelPrefix;
  readonly subscribe?: (name: string, handler: (payload: unknown) => void) => () => void;
};

export interface RpcEventBus<
  C extends RpcContract<readonly AnyMethod[], readonly AnyEvent[]>
> {
  readonly emit: <E extends C["events"][number]>(
    event: E,
    payload: RpcEventPayload<E>
  ) => Effect.Effect<void, never>;
}

export interface EventSubscriber<
  C extends RpcContract<readonly AnyMethod[], readonly AnyEvent[]>
> {
  readonly subscribe: <E extends C["events"][number]>(
    event: E,
    handler: (payload: RpcEventPayload<E>) => void
  ) => () => void;
  readonly subscribeByName: (
    name: C["events"][number]["name"],
    handler: (payload: unknown) => void
  ) => () => void;
}
