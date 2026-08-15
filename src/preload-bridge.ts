import { isFunctionValue, isRecord, type IpcEncodedValue } from "./boundary.ts";
import {
  assertValidChannelPrefix,
  defaultChannelPrefix,
  type ChannelPrefix,
  type EventSubscribe,
  type IpcInvokeEvent,
  type OnStreamFrame,
  type RpcInvoke,
} from "./types.ts";

export type ExposedRpcApi = {
  readonly invoke: RpcInvoke;
  readonly onStreamFrame: OnStreamFrame;
};

export type ExposedEventsApi = {
  readonly subscribe: EventSubscribe;
};

export type ExposedIpcApi = {
  readonly invoke: RpcInvoke;
  readonly subscribe: EventSubscribe;
  readonly onStreamFrame: OnStreamFrame;
};

export type ExposedBridgeValue = ExposedRpcApi | ExposedEventsApi | ExposedIpcApi;

export type BridgeAdapters = {
  readonly invoke: RpcInvoke;
  readonly subscribe: EventSubscribe;
  readonly onStreamFrame: OnStreamFrame;
};

export type BridgeAdaptersOptions = {
  readonly channelPrefix?: ChannelPrefix;
};

export type BridgeExposureOptions = BridgeAdaptersOptions & {
  readonly rpcGlobal?: string;
  readonly eventsGlobal?: string;
};

export type IpcBridgeExposureOptions = BridgeAdaptersOptions & {
  readonly global?: string;
};

type ContextBridgeLike = {
  readonly exposeInMainWorld: (name: string, value: ExposedBridgeValue) => void;
};

type IpcRendererLike = {
  readonly invoke: (channel: string, payload: IpcEncodedValue) => Promise<IpcEncodedValue>;
  readonly on: (
    channel: string,
    handler: (event: IpcInvokeEvent, payload: IpcEncodedValue) => void,
  ) => void;
  readonly removeListener: (
    channel: string,
    handler: (event: IpcInvokeEvent, payload: IpcEncodedValue) => void,
  ) => void;
};

export type ElectronRendererBindings = {
  readonly contextBridge: ContextBridgeLike;
  readonly ipcRenderer: IpcRendererLike;
};

type ElectronRuntimeFunction = (...arguments_: never[]) => void;

type ElectronDirectModuleCandidate = {
  readonly contextBridge: {
    readonly exposeInMainWorld: ElectronRuntimeFunction;
  };
  readonly ipcRenderer: {
    readonly invoke: ElectronRuntimeFunction;
    readonly on: ElectronRuntimeFunction;
    readonly removeListener: ElectronRuntimeFunction;
  };
};

export type ElectronModuleCandidate =
  | ElectronDirectModuleCandidate
  | { readonly default: ElectronModuleCandidate };

function isContextBridgeLike<T>(value: T): value is T & ContextBridgeLike {
  return isRecord(value) && isFunctionValue(value.exposeInMainWorld);
}

function isIpcRendererLike<T>(value: T): value is T & IpcRendererLike {
  return (
    isRecord(value) &&
    isFunctionValue(value.invoke) &&
    isFunctionValue(value.on) &&
    isFunctionValue(value.removeListener)
  );
}

function isElectronRendererBindings<T>(value: T): value is T & ElectronRendererBindings {
  return (
    isRecord(value) &&
    isContextBridgeLike(value.contextBridge) &&
    isIpcRendererLike(value.ipcRenderer)
  );
}

function parseElectronRendererBindings<T>(value: T): ElectronRendererBindings | null {
  return isElectronRendererBindings(value) ? value : null;
}

export function resolveElectronRendererBindings<T>(moduleCandidate: T): ElectronRendererBindings {
  const direct = parseElectronRendererBindings(moduleCandidate);
  if (direct) {
    return direct;
  }

  if (isRecord(moduleCandidate)) {
    const fromDefault = parseElectronRendererBindings(moduleCandidate.default);
    if (fromDefault) {
      return fromDefault;
    }
  }

  throw new Error("electron-effect-rpc/preload requires Electron preload runtime bindings.");
}

export function createBridgeAdaptersFromBindings(
  bindings: ElectronRendererBindings,
  options?: BridgeAdaptersOptions,
): BridgeAdapters {
  const channelPrefix = options?.channelPrefix
    ? assertValidChannelPrefix(options.channelPrefix)
    : defaultChannelPrefix;
  const { ipcRenderer } = bindings;

  const invoke: RpcInvoke = (method, payload) =>
    ipcRenderer.invoke(`${channelPrefix.rpc}${method}`, payload);

  const subscribe: EventSubscribe = (event, listener) => {
    const wrapped = (_event: IpcInvokeEvent, payload: IpcEncodedValue) => listener(payload);

    const channel = `${channelPrefix.event}${event}`;
    ipcRenderer.on(channel, wrapped);

    return () => {
      ipcRenderer.removeListener(channel, wrapped);
    };
  };

  const onStreamFrame: OnStreamFrame = (listener) => {
    const channel = `${channelPrefix.rpc}sf`;
    const wrapped = (_event: IpcInvokeEvent, frame: IpcEncodedValue) => listener(frame);
    ipcRenderer.on(channel, wrapped);
    return () => {
      ipcRenderer.removeListener(channel, wrapped);
    };
  };

  return {
    invoke,
    subscribe,
    onStreamFrame,
  };
}

export function exposeRpcBridgeFromBindings(
  bindings: ElectronRendererBindings,
  options?: BridgeExposureOptions,
): void {
  const rpcGlobal = options?.rpcGlobal ?? "rpc";
  const eventsGlobal = options?.eventsGlobal ?? "events";
  const { contextBridge } = bindings;

  const adapters = createBridgeAdaptersFromBindings(bindings, {
    channelPrefix: options?.channelPrefix,
  });

  contextBridge.exposeInMainWorld(rpcGlobal, {
    invoke: adapters.invoke,
    onStreamFrame: adapters.onStreamFrame,
  });

  contextBridge.exposeInMainWorld(eventsGlobal, {
    subscribe: adapters.subscribe,
  });
}

export function exposeIpcBridgeFromBindings(
  bindings: ElectronRendererBindings,
  options?: IpcBridgeExposureOptions,
): void {
  const global = options?.global ?? "api";
  const { contextBridge } = bindings;

  const adapters = createBridgeAdaptersFromBindings(bindings, {
    channelPrefix: options?.channelPrefix,
  });

  contextBridge.exposeInMainWorld(global, {
    invoke: adapters.invoke,
    subscribe: adapters.subscribe,
    onStreamFrame: adapters.onStreamFrame,
  });
}
