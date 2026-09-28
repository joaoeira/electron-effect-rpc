/**
 * Serves Effect RPC groups from an Electron utility process.
 *
 * Clients are the main process (`UtilityRpcClient`) and renderers whose
 * connections main forwards with `MainRpcServer.layerForward`.
 *
 * ```ts
 * // utility process entry
 * Layer.launch(UtilityRpcServer.layer(WorkerRpcs).pipe(Layer.provide(WorkerHandlers)))
 * ```
 *
 * @since 1.0.0
 */
import { Context, Effect, Layer, Predicate } from "effect";
import type { Rpc, RpcGroup } from "effect/unstable/rpc";
import { RpcServer } from "effect/unstable/rpc";
import type { MessageEvent } from "electron";
import { defaultEndpoint } from "./internal/connect.ts";
import { fromMessagePortMain, makeEndpointRegistry } from "./internal/endpoints.ts";
import * as PortProtocol from "./PortProtocol.ts";

const endpoints = makeEndpointRegistry<void>((dispatch) => {
  const parentPort = process.parentPort;
  if (Predicate.isUndefined(parentPort)) {
    throw new Error("UtilityRpcServer can only run inside an Electron utility process.");
  }
  const onMessage = (event: MessageEvent) =>
    dispatch({ data: event.data, ports: event.ports, source: undefined });
  parentPort.on("message", onMessage);
  return () => {
    parentPort.off("message", onMessage);
  };
});

/**
 * @category models
 * @since 1.0.0
 */
export interface ServeOptions {
  /** Defaults to `"default"`. */
  readonly endpoint?: string | undefined;
}

/**
 * @category models
 * @since 1.0.0
 */
export interface LayerOptions extends ServeOptions {
  readonly disableTracing?: boolean | undefined;
  readonly spanPrefix?: string | undefined;
  readonly spanAttributes?: Record<string, string> | undefined;
  readonly concurrency?: number | "unbounded" | undefined;
  /** Defaults to `true`: a defect only fails the request that caused it. */
  readonly disableFatalDefects?: boolean | undefined;
}

/**
 * Provides an `RpcServer.Protocol` serving connections on an endpoint.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerProtocol = (options?: ServeOptions): Layer.Layer<RpcServer.Protocol> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const server = yield* PortProtocol.makeServer<void>();
      yield* endpoints.register(options?.endpoint ?? defaultEndpoint, (port) =>
        server.accept(fromMessagePortMain(port), undefined),
      );
      return Context.make(RpcServer.Protocol, server.protocol);
    }),
  );

/**
 * Serves an RPC group. Requires the group's handlers and middleware.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer = <Rpcs extends Rpc.Any>(
  group: RpcGroup.RpcGroup<Rpcs>,
  options?: LayerOptions,
) =>
  RpcServer.layer(group, {
    disableTracing: options?.disableTracing,
    spanPrefix: options?.spanPrefix,
    spanAttributes: options?.spanAttributes,
    concurrency: options?.concurrency,
    disableFatalDefects: options?.disableFatalDefects ?? true,
  }).pipe(Layer.provide(layerProtocol(options)));
