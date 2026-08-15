import { Effect } from "effect";
import type * as Context from "effect/Context";
import type {
  AnyEvent,
  AnyMethod,
  AnyStreamMethod,
  RpcContract,
  RpcEventPayload,
} from "./contract.ts";
import { createEventPublisher, createRpcEndpoint } from "./main.ts";
import {
  createBridgeAdaptersFromBindings,
  exposeIpcBridgeFromBindings,
  resolveElectronRendererBindings,
} from "./preload-bridge.ts";
import { createEventSubscriber, createRpcClient, createStreamRpcClient } from "./renderer.ts";
import {
  assertValidChannelPrefix,
  defaultChannelPrefix,
  type ChannelPrefix,
  type EventDecodeMode,
  type EventPublisherDiagnostics,
  type EventSubscribe,
  type EventSubscriber,
  type EventSubscriberDiagnostics,
  type IpcMainLike,
  type Implementations,
  type OnStreamFrame,
  type RendererWindowLike,
  type RpcClient,
  type RpcClientDiagnostics,
  type RpcEndpoint,
  type RpcEndpointDiagnostics,
  type RpcEventPublisher,
  type RpcInvoke,
  type RpcResponseDecodeMode,
  type StreamImplementations,
  type StreamRpcClient,
  type StreamRpcClientHandle,
  type StreamBufferOptions,
} from "./types.ts";

/**
 * Narrow surface the preload script exposes to the renderer.
 *
 * Implementations are responsible for applying the kit's channel prefixes:
 * `invoke(method, payload)` must call `ipcRenderer.invoke(channelPrefix.rpc +
 * method, payload)`, `subscribe(name, ...)` must listen on
 * `channelPrefix.event + name`, and `onStreamFrame` must listen on
 * `channelPrefix.rpc + "sf"`. The bridge produced by `ipc.preload()` does this
 * for you; hand-written bridges that skip the prefixes fail with
 * `invoke_failed` defects at runtime.
 */
export type IpcBridge = {
  readonly invoke: RpcInvoke;
  readonly subscribe: EventSubscribe;
  readonly onStreamFrame?: OnStreamFrame;
};

export type IpcBridgeGlobal<Name extends string = "api"> = {
  readonly [K in Name]: IpcBridge;
};

export type IpcKitOptions<
  C extends RpcContract<readonly AnyMethod[], readonly AnyEvent[], readonly AnyStreamMethod[]>,
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
  readonly streamBuffer?: StreamBufferOptions;
};

type IpcMainOptions<
  C extends RpcContract<readonly AnyMethod[], readonly AnyEvent[], readonly AnyStreamMethod[]>,
  R,
> = {
  readonly ipcMain: IpcMainLike;
  readonly handlers: Implementations<C, R>;
  readonly context: Context.Context<R>;
  readonly getWindows: () => ReadonlyArray<RendererWindowLike>;
  readonly maxQueueSize?: number;
  readonly streamHandlers?: StreamImplementations<C, R>;
  readonly diagnostics?: {
    readonly rpc?: RpcEndpointDiagnostics;
    readonly events?: EventPublisherDiagnostics;
  };
};

type IpcPreloadOptions = {
  readonly global?: string;
  readonly electronModule?: unknown;
};

type IpcRendererOptions = {
  readonly diagnostics?: {
    readonly rpc?: RpcClientDiagnostics;
    readonly events?: EventSubscriberDiagnostics;
    readonly stream?: RpcClientDiagnostics;
  };
};

export type IpcMainHandle<
  C extends RpcContract<readonly AnyMethod[], readonly AnyEvent[], readonly AnyStreamMethod[]>,
> = {
  readonly endpoint: RpcEndpoint;
  readonly publisher: RpcEventPublisher<C>;
  readonly start: () => void;
  readonly stop: () => void;
  readonly dispose: () => void;
  readonly isRunning: () => boolean;
  readonly publish: <E extends C["events"][number]>(
    event: E,
    payload: RpcEventPayload<E>,
  ) => Effect.Effect<void, never>;
  readonly stats: () => {
    readonly queued: number;
    readonly dropped: number;
  };
};

export type IpcKit<
  C extends RpcContract<readonly AnyMethod[], readonly AnyEvent[], readonly AnyStreamMethod[]>,
> = {
  readonly contract: C;
  readonly config: {
    readonly channelPrefix: ChannelPrefix;
    readonly bridgeGlobal: string;
    readonly rpcDecodeMode: RpcResponseDecodeMode;
    readonly eventDecodeMode: EventDecodeMode;
    readonly streamBuffer: StreamBufferOptions;
  };
  readonly main: <R>(options: IpcMainOptions<C, R>) => IpcMainHandle<C>;
  readonly preload: (options?: IpcPreloadOptions) => {
    readonly global: string;
    readonly bridge: IpcBridge;
    readonly expose: () => void;
  };
  readonly renderer: (
    bridge: IpcBridge,
    options?: IpcRendererOptions,
  ) => {
    readonly client: RpcClient<C>;
    readonly events: EventSubscriber<C>;
    readonly streamClient: StreamRpcClient<C>;
    readonly dispose: () => void;
  };
};

function loadElectronModule(electronModule: unknown): unknown {
  if (electronModule !== undefined) {
    return electronModule;
  }

  if (typeof require === "function") {
    return require("electron");
  }

  throw new Error(
    "ipc.preload() could not load Electron synchronously. " +
      "In ESM preload files, pass it explicitly: ipc.preload({ electronModule: electron }).",
  );
}

export function createIpcKit<
  const Methods extends ReadonlyArray<AnyMethod>,
  const Events extends ReadonlyArray<AnyEvent>,
  const StreamMethods extends ReadonlyArray<AnyStreamMethod> = readonly [],
>(
  options: IpcKitOptions<RpcContract<Methods, Events, StreamMethods>>,
): IpcKit<RpcContract<Methods, Events, StreamMethods>> {
  const normalizeStreamBuffer = (buffer: StreamBufferOptions | undefined): StreamBufferOptions => {
    if (!buffer || buffer.bufferSize === "unbounded") {
      const resolved: StreamBufferOptions = { bufferSize: "unbounded" };
      return Object.freeze(resolved);
    }
    const resolved: StreamBufferOptions = {
      bufferSize: buffer.bufferSize,
      strategy: buffer.strategy,
    };
    return Object.freeze(resolved);
  };

  const contract = options.contract;
  const channelPrefix = options.channelPrefix
    ? assertValidChannelPrefix({ ...options.channelPrefix })
    : { ...defaultChannelPrefix };
  const bridgeGlobal = options.bridge?.global ?? "api";
  const rpcDecodeMode = options.decode?.rpc ?? "envelope";
  const eventDecodeMode = options.decode?.events ?? "safe";
  const streamBuffer = normalizeStreamBuffer(options.streamBuffer);

  const main = <R>(
    mainOptions: IpcMainOptions<RpcContract<Methods, Events, StreamMethods>, R>,
  ): IpcMainHandle<RpcContract<Methods, Events, StreamMethods>> => {
    const endpoint = createRpcEndpoint(contract, mainOptions.ipcMain, mainOptions.handlers, {
      context: mainOptions.context,
      channelPrefix,
      diagnostics: mainOptions.diagnostics?.rpc,
      streamHandlers: mainOptions.streamHandlers,
    });

    const publisher = createEventPublisher(contract, {
      getWindows: mainOptions.getWindows,
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

    function publish<E extends RpcContract<Methods, Events, StreamMethods>["events"][number]>(
      event: E,
      payload: RpcEventPayload<E>,
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

  const preload = (preloadOptions?: IpcPreloadOptions) => {
    const bindings = resolveElectronRendererBindings(
      loadElectronModule(preloadOptions?.electronModule),
    );
    const global = preloadOptions?.global ?? bridgeGlobal;
    const bridge = createBridgeAdaptersFromBindings(bindings, {
      channelPrefix,
    });

    return {
      global,
      bridge,
      expose: () => {
        exposeIpcBridgeFromBindings(bindings, {
          global,
          channelPrefix,
        });
      },
    };
  };

  const renderer = (bridge: IpcBridge, rendererOptions?: IpcRendererOptions) => {
    const hasStreamMethods = (contract.streamMethods?.length ?? 0) > 0;

    if (hasStreamMethods && !bridge.onStreamFrame) {
      throw new Error(
        "Contract defines stream methods but bridge.onStreamFrame is missing. " +
          "Ensure the preload bridge exposes onStreamFrame.",
      );
    }

    let streamHandle: StreamRpcClientHandle<RpcContract<Methods, Events, StreamMethods>> | null =
      null;
    if (hasStreamMethods && bridge.onStreamFrame) {
      streamHandle = createStreamRpcClient(contract, {
        invoke: bridge.invoke,
        onStreamFrame: bridge.onStreamFrame,
        streamBuffer,
        diagnostics: rendererOptions?.diagnostics?.stream,
      });
    }

    const emptyStreamClient: StreamRpcClient<RpcContract<Methods, Events, StreamMethods>> =
      Object.create(null);

    return {
      client: createRpcClient(contract, {
        invoke: bridge.invoke,
        rpcDecodeMode,
        diagnostics: rendererOptions?.diagnostics?.rpc,
      }),
      events: createEventSubscriber(contract, {
        subscribe: bridge.subscribe,
        decodeMode: eventDecodeMode,
        diagnostics: rendererOptions?.diagnostics?.events,
      }),
      streamClient: streamHandle?.client ?? emptyStreamClient,
      dispose: () => {
        streamHandle?.dispose();
      },
    };
  };

  return {
    contract,
    config: {
      channelPrefix,
      bridgeGlobal,
      rpcDecodeMode,
      eventDecodeMode,
      streamBuffer,
    },
    main,
    preload,
    renderer,
  };
}
