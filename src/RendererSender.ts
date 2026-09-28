/**
 * Access to the renderer that sent a request, for handlers served from the
 * main process.
 *
 * Add `RendererSenderMiddleware` to the RPCs (or the whole group) that need
 * it, then read `RendererSender` in their handlers. `MainRpcServer` provides
 * the middleware.
 *
 * ```ts
 * export class AppRpcs extends RpcGroup.make(
 *   Rpc.make("OpenDevTools"),
 * ).middleware(RendererSenderMiddleware) {}
 *
 * AppRpcs.toLayer({
 *   OpenDevTools: () =>
 *     Effect.gen(function* () {
 *       const { webContents } = yield* RendererSender
 *       webContents.openDevTools()
 *     }),
 * })
 * ```
 *
 * @since 1.0.0
 */
import { Context } from "effect";
import { RpcMiddleware } from "effect/unstable/rpc";
import type { WebContents, WebFrameMain } from "electron";

/**
 * The renderer a request came from, as it was when it connected.
 *
 * @category services
 * @since 1.0.0
 */
export class RendererSender extends Context.Service<
  RendererSender,
  {
    readonly webContents: WebContents;
    /** The frame that opened the connection, if it still existed when it connected. */
    readonly frame: WebFrameMain | null;
  }
>()("electron-effect-rpc/RendererSender") {}

/**
 * Provides `RendererSender` to the handlers of the RPCs it is applied to.
 *
 * @category middleware
 * @since 1.0.0
 */
export class RendererSenderMiddleware extends RpcMiddleware.Service<
  RendererSenderMiddleware,
  { provides: RendererSender }
>()("electron-effect-rpc/RendererSenderMiddleware") {}
