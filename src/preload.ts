import * as electronModule from "electron";
import type { IpcRendererEvent } from "electron";
import { isRecord } from "./protocol.ts";
import {
  defaultChannelPrefix,
  type ChannelPrefix,
  type EventSubscribe,
  type RpcInvoke,
} from "./types.ts";

export type BridgeAdapters = {
  readonly invoke: RpcInvoke;
  readonly subscribe: EventSubscribe;
  readonly onStreamFrame: (listener: (frame: unknown) => void) => () => void;
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
  readonly exposeInMainWorld: (name: string, value: Record<string, unknown>) => void;
};

type IpcRendererLike = {
  readonly invoke: (channel: string, payload: unknown) => Promise<unknown>;
  readonly on: (
    channel: string,
    handler: (event: IpcRendererEvent, payload: unknown) => void,
  ) => void;
  readonly removeListener: (
    channel: string,
    handler: (event: IpcRendererEvent, payload: unknown) => void,
  ) => void;
};

function isContextBridgeLike(value: unknown): value is ContextBridgeLike {
  return isRecord(value) && typeof value.exposeInMainWorld === "function";
}

function isIpcRendererLike(value: unknown): value is IpcRendererLike {
  return (
    isRecord(value) &&
    typeof value.invoke === "function" &&
    typeof value.on === "function" &&
    typeof value.removeListener === "function"
  );
}

function resolveElectronRendererBindings(): {
  readonly contextBridge: ContextBridgeLike;
  readonly ipcRenderer: IpcRendererLike;
} {
  const mod: unknown = electronModule;
  const moduleDefault = isRecord(mod) ? mod.default : undefined;
  const source = isRecord(moduleDefault) ? moduleDefault : isRecord(mod) ? mod : undefined;

  if (!source) {
    throw new Error("electron-effect-rpc/preload requires Electron preload runtime bindings.");
  }

  const { contextBridge, ipcRenderer } = source;

  if (!isContextBridgeLike(contextBridge) || !isIpcRendererLike(ipcRenderer)) {
    throw new Error("electron-effect-rpc/preload requires Electron preload runtime bindings.");
  }

  return { contextBridge, ipcRenderer };
}

export function createBridgeAdapters(options?: BridgeAdaptersOptions): BridgeAdapters {
  const channelPrefix = options?.channelPrefix ?? defaultChannelPrefix;
  const { ipcRenderer } = resolveElectronRendererBindings();

  const invoke: RpcInvoke = (method: string, payload: unknown) =>
    ipcRenderer.invoke(`${channelPrefix.rpc}${method}`, payload);

  const subscribe: EventSubscribe = (event, listener) => {
    const wrapped = (_event: IpcRendererEvent, payload: unknown) => listener(payload);

    const channel = `${channelPrefix.event}${event}`;
    ipcRenderer.on(channel, wrapped);

    return () => {
      ipcRenderer.removeListener(channel, wrapped);
    };
  };

  const onStreamFrame = (listener: (frame: unknown) => void) => {
    const channel = `${channelPrefix.rpc}sf`;
    const wrapped = (_event: IpcRendererEvent, frame: unknown) => listener(frame);
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

export function exposeRpcBridge(options?: BridgeExposureOptions): void {
  const rpcGlobal = options?.rpcGlobal ?? "rpc";
  const eventsGlobal = options?.eventsGlobal ?? "events";
  const { contextBridge } = resolveElectronRendererBindings();

  const adapters = createBridgeAdapters({
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

export function exposeIpcBridge(options?: IpcBridgeExposureOptions): void {
  const global = options?.global ?? "api";
  const { contextBridge } = resolveElectronRendererBindings();

  const adapters = createBridgeAdapters({
    channelPrefix: options?.channelPrefix,
  });

  contextBridge.exposeInMainWorld(global, {
    invoke: adapters.invoke,
    subscribe: adapters.subscribe,
    onStreamFrame: adapters.onStreamFrame,
  });
}
