import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
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

export function createBridgeAdapters(
  options?: BridgeAdaptersOptions
): BridgeAdapters {
  const channelPrefix = options?.channelPrefix ?? defaultChannelPrefix;

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
