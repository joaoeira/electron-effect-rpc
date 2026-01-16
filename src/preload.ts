import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { defaultChannelPrefix, type ChannelPrefix } from "./types.ts";

type Listener = (payload: unknown) => void;

type BridgeOptions = {
  readonly rpcGlobal?: string;
  readonly eventsGlobal?: string;
  readonly channelPrefix?: ChannelPrefix;
};

export const exposeRpcBridge = (options?: BridgeOptions): void => {
  const rpcGlobal = options?.rpcGlobal ?? "rpc";
  const eventsGlobal = options?.eventsGlobal ?? "events";
  const channelPrefix = options?.channelPrefix ?? defaultChannelPrefix;

  const invoke = (method: string, payload: unknown): Promise<unknown> =>
    ipcRenderer.invoke(`${channelPrefix.rpc}${method}`, payload);

  const subscribe = (event: string, listener: Listener): (() => void) => {
    const wrapped = (_event: IpcRendererEvent, payload: unknown) =>
      listener(payload);

    ipcRenderer.on(`${channelPrefix.event}${event}`, wrapped);

    return () => {
      ipcRenderer.removeListener(`${channelPrefix.event}${event}`, wrapped);
    };
  };

  contextBridge.exposeInMainWorld(rpcGlobal, { invoke });
  contextBridge.exposeInMainWorld(eventsGlobal, { subscribe });
};
