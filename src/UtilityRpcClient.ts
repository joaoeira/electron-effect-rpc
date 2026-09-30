/**
 * Calls Effect RPC groups served by a utility process (`UtilityRpcServer`)
 * from the main process.
 *
 * ```ts
 * const Worker = Layer.effect(WorkerClient)(RpcClient.make(WorkerRpcs)).pipe(
 *   Layer.provide(UtilityRpcClient.layerProtocol(child)),
 * )
 * ```
 *
 * @since 1.0.0
 */
import { Effect, Layer, Schedule } from "effect";
import type { Duration } from "effect";
import { RpcClient, RpcClientError } from "effect/rpc";
import { Socket } from "effect/socket";
import { MessageChannelMain } from "electron";
import type { UtilityProcess } from "electron";
import { connectRequest, defaultEndpoint } from "./internal/connect.ts";
import { fromMessagePortMain } from "./internal/endpoints.ts";
import * as PortProtocol from "./PortProtocol.ts";

/**
 * @category models
 * @since 1.0.0
 */
export interface ConnectOptions {
  /** The endpoint served inside the utility process. Defaults to `"default"`. */
  readonly endpoint?: string | undefined;
  readonly handshakeTimeout?: Duration.Input | undefined;
  /**
   * Controls reconnection. By default reconnects until the process exits,
   * after which pending and future calls fail.
   */
  readonly retrySchedule?: Schedule.Schedule<unknown, RpcClientError.RpcClientError> | undefined;
}

/**
 * Provides an `RpcClient.Protocol` connected to a utility process.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerProtocol = (
  target: UtilityProcess,
  options?: ConnectOptions,
): Layer.Layer<RpcClient.Protocol> =>
  Layer.effect(RpcClient.Protocol)(
    Effect.gen(function* () {
      const endpoint = options?.endpoint ?? defaultEndpoint;
      // A connection request posted to an exited process is silently dropped,
      // so reconnecting would only wait out the handshake timeout.
      let exited = false;
      const onExit = () => {
        exited = true;
      };
      yield* Effect.acquireRelease(
        Effect.sync(() => target.once("exit", onExit)),
        () => Effect.sync(() => target.removeListener("exit", onExit)),
      );

      const connect = Effect.acquireRelease(
        Effect.try({
          try: () => {
            if (exited) throw new Error("The utility process has exited.");
            const { port1, port2 } = new MessageChannelMain();
            target.postMessage(connectRequest(endpoint), [port2]);
            return port1;
          },
          catch: (cause) =>
            new RpcClientError.RpcClientError({
              reason: new Socket.SocketOpenError({ kind: "Unknown", cause }),
            }),
        }),
        (port) => Effect.sync(() => port.close()),
      ).pipe(Effect.map(fromMessagePortMain));

      return yield* PortProtocol.makeClient({
        connect,
        name: `Utility process endpoint "${endpoint}"`,
        handshakeTimeout: options?.handshakeTimeout,
        retrySchedule:
          options?.retrySchedule ??
          PortProtocol.defaultRetrySchedule.pipe(Schedule.while(() => !exited)),
      });
    }),
  );
