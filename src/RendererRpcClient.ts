/**
 * Calls Effect RPC groups served by the main process (or forwarded to a
 * utility process) from a renderer.
 *
 * Requires `exposeRpcBridge()` in the window's preload script.
 *
 * ```ts
 * class Api extends Context.Service<Api, RpcClient.FromGroup<typeof AppRpcs, RpcClientError>>()("Api") {
 *   static layer = Layer.effect(Api)(RpcClient.make(AppRpcs)).pipe(
 *     Layer.provide(RendererRpcClient.layerProtocol()),
 *   )
 * }
 * ```
 *
 * @since 1.0.0
 */
import { Effect, Layer } from "effect";
import type { Duration, Schedule } from "effect";
import { RpcClient } from "effect/unstable/rpc";
import type { RpcClientError } from "effect/unstable/rpc";
import { connectRequest, defaultEndpoint } from "./internal/connect.ts";
import * as PortProtocol from "./PortProtocol.ts";

/**
 * @category models
 * @since 1.0.0
 */
export interface ConnectOptions {
  /** The endpoint to connect to. Defaults to `"default"`. */
  readonly endpoint?: string | undefined;
  readonly handshakeTimeout?: Duration.Input | undefined;
  readonly retrySchedule?: Schedule.Schedule<unknown, RpcClientError.RpcClientError> | undefined;
}

/**
 * Provides an `RpcClient.Protocol` connected to an endpoint in the main
 * process. Calls made before the connection is established wait for it.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerProtocol = (options?: ConnectOptions): Layer.Layer<RpcClient.Protocol> => {
  const endpoint = options?.endpoint ?? defaultEndpoint;
  const connect = Effect.acquireRelease(
    Effect.sync(() => {
      const { port1, port2 } = new MessageChannel();
      // The preload bridge picks this up and forwards the port to main.
      window.postMessage(connectRequest(endpoint), "*", [port2]);
      return port1;
    }),
    (port) => Effect.sync(() => port.close()),
  ).pipe(Effect.map(PortProtocol.fromMessagePort));

  return Layer.effect(RpcClient.Protocol)(
    PortProtocol.makeClient({
      connect,
      name: `Electron RPC endpoint "${endpoint}"`,
      handshakeTimeout: options?.handshakeTimeout,
      retrySchedule: options?.retrySchedule,
    }),
  );
};
