/**
 * Serves Effect RPC groups from the Electron main process to renderers.
 *
 * Each renderer connection is its own `MessagePort`, opened by the renderer
 * through the preload bridge. When the page reloads, navigates, crashes or its
 * window closes, the port closes and everything that renderer had in flight is
 * interrupted.
 *
 * ```ts
 * const RpcLive = MainRpcServer.layer(AppRpcs).pipe(Layer.provide(AppHandlers))
 * ```
 *
 * @since 1.0.0
 */
import { Context, Effect, FiberSet, Layer } from "effect";
import type { Rpc, RpcGroup } from "effect/rpc";
import { RpcServer } from "effect/rpc";
import { ipcMain } from "electron";
import type { IpcMainEvent, MessagePortMain, UtilityProcess } from "electron";
import { connectRequest, connectTag, defaultEndpoint } from "./internal/connect.ts";
import { fromMessagePortMain, makeEndpointRegistry } from "./internal/endpoints.ts";
import * as PortProtocol from "./PortProtocol.ts";
import { RendererSender, RendererSenderMiddleware } from "./RendererSender.ts";

const endpoints = makeEndpointRegistry<IpcMainEvent>((dispatch) => {
  const onConnect = (event: IpcMainEvent, ...args: Array<unknown>) =>
    dispatch({ data: args[0], ports: event.ports, source: event });
  ipcMain.on(connectTag, onConnect);
  return () => {
    ipcMain.removeListener(connectTag, onConnect);
  };
});

/**
 * @category models
 * @since 1.0.0
 */
export interface ServeOptions {
  /** The endpoint renderers connect to. Defaults to `"default"`. */
  readonly endpoint?: string | undefined;
  /**
   * Decides whether a renderer may connect, for example by checking
   * `frame.url`. Every renderer running the preload bridge is accepted by
   * default. A rejected renderer's calls fail with an `RpcClientDefect`; it
   * does not reconnect.
   */
  readonly authorize?:
    | ((sender: RendererSender["Service"]) => boolean | Effect.Effect<boolean>)
    | undefined;
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
  /**
   * When `false`, a defect in any handler fails every request of that
   * renderer, which is `RpcServer`'s own default. Defaults to `true` here, so
   * a defect only fails the request that caused it.
   */
  readonly disableFatalDefects?: boolean | undefined;
}

const makeAccept = Effect.fnUntraced(function* (
  endpoint: string,
  authorize: ServeOptions["authorize"],
  accept: (port: MessagePortMain, sender: RendererSender["Service"]) => void,
) {
  const runFork = yield* FiberSet.makeRuntime<never, void, never>();
  const refuse = (port: MessagePortMain) =>
    PortProtocol.reject(
      fromMessagePortMain(port),
      `The renderer is not authorized to use the RPC endpoint "${endpoint}".`,
    );
  return (port: MessagePortMain, event: IpcMainEvent) => {
    const sender = { webContents: event.sender, frame: event.senderFrame };
    if (authorize === undefined) {
      accept(port, sender);
      return;
    }
    runFork(
      Effect.suspend(() => {
        const allowed = authorize(sender);
        return Effect.isEffect(allowed) ? allowed : Effect.succeed(allowed);
      }).pipe(
        Effect.flatMap((allowed) =>
          Effect.sync(() => (allowed ? accept(port, sender) : refuse(port))),
        ),
        Effect.catchCause((cause) =>
          Effect.andThen(
            Effect.sync(() => refuse(port)),
            Effect.logError(`authorize failed for the RPC endpoint "${endpoint}"`, cause),
          ),
        ),
        Effect.onInterrupt(() => Effect.sync(() => port.close())),
      ),
    );
  };
});

/**
 * Provides an `RpcServer.Protocol` serving renderer connections on an
 * endpoint, together with the `RendererSenderMiddleware` implementation.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerProtocol = (
  options?: ServeOptions,
): Layer.Layer<RpcServer.Protocol | RendererSenderMiddleware> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const endpoint = options?.endpoint ?? defaultEndpoint;
      const server = yield* PortProtocol.makeServer<RendererSender["Service"]>();
      const onConnect = yield* makeAccept(endpoint, options?.authorize, (port, sender) =>
        server.accept(fromMessagePortMain(port), sender),
      );
      yield* endpoints.register(endpoint, onConnect);

      const senderMiddleware = RendererSenderMiddleware.of((effect, { client }) => {
        const sender = server.metadata(client.id);
        return sender === undefined
          ? Effect.interrupt
          : Effect.provideService(effect, RendererSender, sender);
      });

      return Context.make(RpcServer.Protocol, server.protocol).pipe(
        Context.add(RendererSenderMiddleware, senderMiddleware),
      );
    }),
  );

/**
 * Serves an RPC group to renderers. Requires the group's handlers (from
 * `group.toLayer`) and any middleware other than `RendererSenderMiddleware`.
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

/**
 * @category models
 * @since 1.0.0
 */
export interface ForwardOptions extends ServeOptions {
  /** The utility process that serves the endpoint. */
  readonly target: Pick<UtilityProcess, "postMessage">;
  /** The endpoint served inside the target. Defaults to `"default"`. */
  readonly targetEndpoint?: string | undefined;
}

/**
 * Hands renderer connections for an endpoint to a utility process running
 * `UtilityRpcServer`. After the handoff the renderer and the utility process
 * talk directly; main does not relay any messages.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerForward = (options: ForwardOptions): Layer.Layer<never> =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const endpoint = options.endpoint ?? defaultEndpoint;
      const request = connectRequest(options.targetEndpoint ?? defaultEndpoint);
      const onConnect = yield* makeAccept(endpoint, options.authorize, (port) => {
        try {
          options.target.postMessage(request, [port]);
        } catch {
          // The process is gone. Closing the port lets the renderer retry.
          port.close();
        }
      });
      yield* endpoints.register(endpoint, onConnect);
    }),
  );
