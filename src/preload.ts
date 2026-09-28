/**
 * The preload half of the renderer connection.
 *
 * A context-isolated page cannot reach `ipcRenderer`, and `contextBridge`
 * cannot carry a `MessagePort`. So the page posts one end of a
 * `MessageChannel` to its own window, and this bridge, which shares the DOM
 * with the page, forwards it to the main process. After that the page and main
 * talk over the port directly; nothing else passes through the preload.
 *
 * The bridge knows nothing about your RPCs, and the page can only reach the
 * connection channel, never arbitrary IPC channels.
 *
 * @since 1.0.0
 */
import { Predicate } from "effect";
import { ipcRenderer } from "electron";
import { connectRequest, connectTag, rejection } from "./internal/connect.ts";

/**
 * @category models
 * @since 1.0.0
 */
export interface BridgeOptions {
  /**
   * The endpoints this page may connect to. All endpoints by default. Calls to
   * other endpoints fail with an `RpcClientDefect`.
   */
  readonly endpoints?: ReadonlyArray<string> | undefined;
}

let exposed = false;

/**
 * Lets the page open RPC connections. Call once from the preload script.
 *
 * @category bridge
 * @since 1.0.0
 */
export const exposeRpcBridge = (options?: BridgeOptions): void => {
  if (exposed) return;
  exposed = true;
  const allowed = options?.endpoints === undefined ? undefined : new Set(options.endpoints);

  window.addEventListener("message", (event) => {
    // Only the page itself, not frames embedded in it.
    if (event.source !== window) return;
    const data = event.data;
    if (
      !Predicate.isTagged(data, connectTag) ||
      !Predicate.hasProperty(data, "endpoint") ||
      !Predicate.isString(data.endpoint)
    ) {
      return;
    }
    const [port] = event.ports;
    if (port === undefined) return;
    if (allowed !== undefined && !allowed.has(data.endpoint)) {
      port.postMessage(
        rejection(`The preload bridge does not allow the RPC endpoint "${data.endpoint}".`),
      );
      port.close();
      return;
    }
    ipcRenderer.postMessage(connectTag, connectRequest(data.endpoint), [port]);
  });
};
