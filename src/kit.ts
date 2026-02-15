import { Effect } from "effect";
import type * as Runtime from "effect/Runtime";
import type { AnyEvent, AnyMethod, RpcContract, RpcEventPayload } from "./contract.ts";
import { createEventPublisher, createRpcEndpoint } from "./main.ts";
import { exposeIpcBridge, createBridgeAdapters } from "./preload.ts";
import { createEventSubscriber, createRpcClient } from "./renderer.ts";
import {
  defaultChannelPrefix,
  type ChannelPrefix,
  type EventDecodeMode,
  type EventPublisherDiagnostics,
  type EventSubscribe,
  type EventSubscriber,
  type IpcMainLike,
  type Implementations,
  type RendererWindowLike,
  type RpcClient,
  type RpcEndpoint,
  type RpcEndpointDiagnostics,
  type RpcEventPublisher,
  type RpcInvoke,
  type RpcResponseDecodeMode,
} from "./types.ts";

export type IpcBridge = {
  readonly invoke: RpcInvoke;
  readonly subscribe: EventSubscribe;
};

export type IpcBridgeGlobal<Name extends string = "api"> = {
  readonly [K in Name]: IpcBridge;
};

export type IpcKitOptions<
  C extends RpcContract<readonly AnyMethod[], readonly AnyEvent[]>
> = {
  readonly contract: C;
  readonly channelPrefix?: ChannelPrefix;
  readonly bridge?: {
    readonly global?: string;
  };
  readonly decode?: {
    readonly rpc?: RpcResponseDecodeMode;
    readonly events?: EventDecodeMode;
  };
};

type IpcMainOptions<
  C extends RpcContract<readonly AnyMethod[], readonly AnyEvent[]>,
  R
> = {
  readonly ipcMain: IpcMainLike;
  readonly handlers: Implementations<C, R>;
  readonly runtime: Runtime.Runtime<R>;
  readonly getWindow: () => RendererWindowLike | null;
  readonly maxQueueSize?: number;
  readonly diagnostics?: {
    readonly rpc?: RpcEndpointDiagnostics;
    readonly events?: EventPublisherDiagnostics;
  };
};

export type IpcMainHandle<
  C extends RpcContract<readonly AnyMethod[], readonly AnyEvent[]>
> = {
  readonly endpoint: RpcEndpoint;
  readonly publisher: RpcEventPublisher<C>;
  readonly start: () => void;
  readonly stop: () => void;
  readonly dispose: () => void;
  readonly isRunning: () => boolean;
  readonly publish: <E extends C["events"][number]>(
    event: E,
    payload: RpcEventPayload<E>
  ) => Effect.Effect<void, never>;
  readonly stats: () => {
    readonly queued: number;
    readonly dropped: number;
  };
};

export type IpcKit<
  C extends RpcContract<readonly AnyMethod[], readonly AnyEvent[]>
> = {
  readonly contract: C;
  readonly config: {
    readonly channelPrefix: ChannelPrefix;
    readonly bridgeGlobal: string;
    readonly rpcDecodeMode: RpcResponseDecodeMode;
    readonly eventDecodeMode: EventDecodeMode;
  };
  readonly main: <R>(options: IpcMainOptions<C, R>) => IpcMainHandle<C>;
  readonly preload: (options?: { readonly global?: string }) => {
    readonly global: string;
    readonly bridge: IpcBridge;
    readonly expose: () => void;
  };
  readonly renderer: (bridge: IpcBridge) => {
    readonly client: RpcClient<C>;
    readonly events: EventSubscriber<C>;
  };
};

export function createIpcKit<
  const Methods extends ReadonlyArray<AnyMethod>,
  const Events extends ReadonlyArray<AnyEvent>
>(
  options: IpcKitOptions<RpcContract<Methods, Events>>
): IpcKit<RpcContract<Methods, Events>> {
  const contract = options.contract;
  const channelPrefix = options.channelPrefix
    ? { ...options.channelPrefix }
    : { ...defaultChannelPrefix };
  const bridgeGlobal = options.bridge?.global ?? "api";
  const rpcDecodeMode = options.decode?.rpc ?? "envelope";
  const eventDecodeMode = options.decode?.events ?? "safe";

  const main = <R>(
    mainOptions: IpcMainOptions<RpcContract<Methods, Events>, R>
  ): IpcMainHandle<RpcContract<Methods, Events>> => {
    const endpoint = createRpcEndpoint(
      contract,
      mainOptions.ipcMain,
      mainOptions.handlers,
      {
        runtime: mainOptions.runtime,
        channelPrefix,
        diagnostics: mainOptions.diagnostics?.rpc,
      }
    );

    const publisher = createEventPublisher(contract, {
      getWindow: mainOptions.getWindow,
      maxQueueSize: mainOptions.maxQueueSize,
      channelPrefix,
      diagnostics: mainOptions.diagnostics?.events,
    });

    function start(): void {
      endpoint.start();
      try {
        publisher.start();
      } catch (cause) {
        try {
          endpoint.stop();
        } catch {
          // Best effort rollback.
        }
        throw cause;
      }
    }

    function stop(): void {
      let firstError: unknown;

      try {
        publisher.stop();
      } catch (cause) {
        firstError ??= cause;
      }

      try {
        endpoint.stop();
      } catch (cause) {
        firstError ??= cause;
      }

      if (firstError !== undefined) {
        throw firstError;
      }
    }

    function dispose(): void {
      let firstError: unknown;

      try {
        publisher.dispose();
      } catch (cause) {
        firstError ??= cause;
      }

      try {
        endpoint.dispose();
      } catch (cause) {
        firstError ??= cause;
      }

      if (firstError !== undefined) {
        throw firstError;
      }
    }

    function isRunning(): boolean {
      return endpoint.isRunning() && publisher.isRunning();
    }

    function publish<E extends RpcContract<Methods, Events>["events"][number]>(
      event: E,
      payload: RpcEventPayload<E>
    ): Effect.Effect<void, never> {
      return publisher.publish(event, payload);
    }

    return {
      endpoint,
      publisher,
      start,
      stop,
      dispose,
      isRunning,
      publish,
      stats: publisher.stats,
    };
  };

  const preload = (preloadOptions?: { readonly global?: string }) => {
    const global = preloadOptions?.global ?? bridgeGlobal;
    const bridge = createBridgeAdapters({
      channelPrefix,
    });

    return {
      global,
      bridge,
      expose: () => {
        exposeIpcBridge({
          global,
          channelPrefix,
        });
      },
    };
  };

  const renderer = (bridge: IpcBridge) => {
    return {
      client: createRpcClient(contract, {
        invoke: bridge.invoke,
        rpcDecodeMode,
      }),
      events: createEventSubscriber(contract, {
        subscribe: bridge.subscribe,
        decodeMode: eventDecodeMode,
      }),
    };
  };

  return {
    contract,
    config: {
      channelPrefix,
      bridgeGlobal,
      rpcDecodeMode,
      eventDecodeMode,
    },
    main,
    preload,
    renderer,
  };
}
