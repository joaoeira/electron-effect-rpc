import * as electronModule from "electron";
import type { IpcRendererEvent } from "electron";
import {
  defaultChannelPrefix,
  type ChannelPrefix,
  type EventSubscribe,
  type RpcInvoke,
} from "./types.ts";

export type BridgeAdapters = {
  readonly invoke: RpcInvoke;
  readonly subscribe: EventSubscribe;
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
    handler: (event: IpcRendererEvent, payload: unknown) => void
  ) => void;
  readonly removeListener: (
    channel: string,
    handler: (event: IpcRendererEvent, payload: unknown) => void
  ) => void;
};

function resolveElectronRendererBindings(): {
  readonly contextBridge: ContextBridgeLike;
  readonly ipcRenderer: IpcRendererLike;
} {
  const moduleDefault = (electronModule as { readonly default?: unknown }).default;
  const source =
    moduleDefault && typeof moduleDefault === "object"
      ? (moduleDefault as Record<string, unknown>)
      : (electronModule as Record<string, unknown>);

  const contextBridge = source.contextBridge as ContextBridgeLike | undefined;
  const ipcRenderer = source.ipcRenderer as IpcRendererLike | undefined;

  if (!contextBridge || !ipcRenderer) {
    throw new Error(
      "electron-effect-rpc/preload requires Electron preload runtime bindings."
    );
  }

  return { contextBridge, ipcRenderer };
}

export function createBridgeAdapters(
  options?: BridgeAdaptersOptions
): BridgeAdapters {
  const channelPrefix = options?.channelPrefix ?? defaultChannelPrefix;
  const { ipcRenderer } = resolveElectronRendererBindings();

  const invoke: RpcInvoke = (method: string, payload: unknown) =>
    ipcRenderer.invoke(`${channelPrefix.rpc}${method}`, payload);

  const subscribe: EventSubscribe = (event, listener) => {
    const wrapped = (_event: IpcRendererEvent, payload: unknown) =>
      listener(payload);

    const channel = `${channelPrefix.event}${event}`;
    ipcRenderer.on(channel, wrapped);

    return () => {
      ipcRenderer.removeListener(channel, wrapped);
    };
  };

  return {
    invoke,
    subscribe,
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
  });
}
