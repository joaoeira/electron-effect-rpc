import { Effect, Schema } from "effect";
import type { Scope } from "effect";
import type { MessagePortMain } from "electron";
import type { Port } from "../PortProtocol.ts";
import { connectTag } from "./connect.ts";

const ConnectRequest = Schema.Struct({
  _tag: Schema.tag(connectTag),
  endpoint: Schema.String,
});

const isConnectRequest = Schema.is(ConnectRequest);

/** A message that may carry a connection request, before validation. */
export interface IncomingMessage<Source> {
  readonly data: unknown;
  readonly ports: ReadonlyArray<MessagePortMain>;
  readonly source: Source;
}

export type ConnectionHandler<Source> = (port: MessagePortMain, source: Source) => void;

/**
 * Routes incoming connection requests to the server registered for their
 * endpoint. Starts listening when the first endpoint is registered and stops
 * when the last one is released. Requests for unknown endpoints have their
 * port closed, which the client sees as a failed handshake and retries, so a
 * renderer that connects before its server is up still gets through.
 */
export const makeEndpointRegistry = <Source>(
  listen: (dispatch: (message: IncomingMessage<Source>) => void) => () => void,
) => {
  const handlers = new Map<string, ConnectionHandler<Source>>();
  let unlisten: (() => void) | undefined;

  const dispatch = (message: IncomingMessage<Source>) => {
    if (!isConnectRequest(message.data)) return;
    const [port, ...unexpected] = message.ports;
    for (const extra of unexpected) extra.close();
    if (port === undefined) return;
    const handler = handlers.get(message.data.endpoint);
    if (handler === undefined) {
      port.close();
      return;
    }
    handler(port, message.source);
  };

  const register = (
    endpoint: string,
    handler: ConnectionHandler<Source>,
  ): Effect.Effect<void, never, Scope.Scope> =>
    Effect.acquireRelease(
      Effect.suspend(() => {
        if (handlers.has(endpoint)) {
          return Effect.die(
            new Error(`The RPC endpoint "${endpoint}" is already being served in this process.`),
          );
        }
        handlers.set(endpoint, handler);
        unlisten ??= listen(dispatch);
        return Effect.void;
      }),
      () =>
        Effect.sync(() => {
          handlers.delete(endpoint);
          if (handlers.size === 0 && unlisten !== undefined) {
            unlisten();
            unlisten = undefined;
          }
        }),
    );

  return { register };
};

/** Adapts an Electron `MessagePortMain` (main and utility processes). */
export const fromMessagePortMain = (port: MessagePortMain): Port => ({
  postMessage: (message) => port.postMessage(message),
  start: ({ onMessage, onClose }) => {
    port.on("message", onMessage);
    port.once("close", onClose);
    port.start();
  },
  close: () => port.close(),
});
