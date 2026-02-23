import * as electronModule from "electron";
import {
  createBridgeAdaptersFromBindings,
  exposeIpcBridgeFromBindings,
  exposeRpcBridgeFromBindings,
  resolveElectronRendererBindings,
  type BridgeAdapters,
  type BridgeAdaptersOptions,
  type BridgeExposureOptions,
  type IpcBridgeExposureOptions,
} from "./preload-bridge.ts";

function resolveBindings() {
  return resolveElectronRendererBindings(electronModule);
}

export function createBridgeAdapters(options?: BridgeAdaptersOptions): BridgeAdapters {
  return createBridgeAdaptersFromBindings(resolveBindings(), options);
}

export function exposeRpcBridge(options?: BridgeExposureOptions): void {
  exposeRpcBridgeFromBindings(resolveBindings(), options);
}

export function exposeIpcBridge(options?: IpcBridgeExposureOptions): void {
  exposeIpcBridgeFromBindings(resolveBindings(), options);
}
