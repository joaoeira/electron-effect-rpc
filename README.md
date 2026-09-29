# electron-effect-rpc

[![npm](https://img.shields.io/npm/v/electron-effect-rpc)](https://www.npmjs.com/package/electron-effect-rpc)

An Electron transport for [Effect RPC](https://effect.website).

You define RPCs with `Rpc` and `RpcGroup`, implement them with `group.toLayer`,
and call them with `RpcClient`, exactly as you would over HTTP or WebSockets.
This package only supplies the `RpcServer.Protocol` and `RpcClient.Protocol`
layers that carry those RPCs between Electron processes:

| From     | To                                           | Layers                                                                                      |
| -------- | -------------------------------------------- | ------------------------------------------------------------------------------------------- |
| renderer | main                                         | `RendererRpcClient.layerProtocol` → `MainRpcServer.layer`                                   |
| main     | utility process                              | `UtilityRpcClient.layerProtocol` → `UtilityRpcServer.layer`                                 |
| renderer | utility process (direct, handed off by main) | `RendererRpcClient.layerProtocol` → `MainRpcServer.layerForward` → `UtilityRpcServer.layer` |

Everything Effect RPC does comes along unchanged: typed errors, streams with
backpressure, interruption that reaches the server, middleware, tracing across
processes, and `RpcTest` for unit tests.

ESM only. Tested against Electron 38. Peer dependencies: `effect@^4.0.0-rc.109`,
`electron@>=30`.

## Quickstart

### 1. Define the RPCs (shared)

```ts
// rpcs.ts
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";

export class DownloadFailed extends Schema.TaggedError<DownloadFailed>()("DownloadFailed", {
  url: Schema.String,
}) {}

export class AppRpcs extends RpcGroup.make(
  Rpc.make("GetVersion", { success: Schema.String }),
  Rpc.make("Download", {
    payload: { url: Schema.String },
    success: Schema.Struct({ received: Schema.Number, total: Schema.Number }),
    error: DownloadFailed,
    stream: true,
  }),
) {}
```

### 2. Serve them from main

```ts
// main.ts
import { app, BrowserWindow } from "electron";
import { Effect, Layer, Stream } from "effect";
import { MainRpcServer } from "electron-effect-rpc/main";
import { AppRpcs } from "./rpcs.ts";

const Handlers = AppRpcs.toLayer({
  GetVersion: () => Effect.succeed(app.getVersion()),
  Download: ({ url }) => downloadWithProgress(url), // a Stream
});

const RpcLive = MainRpcServer.layer(AppRpcs).pipe(Layer.provide(Handlers));

app.whenReady().then(() => {
  const server = Effect.runFork(Layer.launch(RpcLive));
  app.on("will-quit", () => server.interruptUnsafe());

  new BrowserWindow({
    webPreferences: { preload: PRELOAD_PATH, sandbox: true, contextIsolation: true },
  });
});
```

It doesn't matter whether windows open before or after the server layer
starts: a renderer that connects early keeps retrying until the endpoint is
served.

### 3. Expose the bridge in preload

```ts
// preload.ts
import { exposeRpcBridge } from "electron-effect-rpc/preload";

exposeRpcBridge();
```

The bridge knows nothing about your RPCs. It forwards connection requests to
main and is not involved after that.

### 4. Call them from the renderer

```ts
// renderer.ts
import { Context, Effect, Layer, ManagedRuntime, Stream } from "effect";
import { RpcClient, type RpcClientError } from "effect/unstable/rpc";
import { RendererRpcClient } from "electron-effect-rpc/renderer";
import { AppRpcs } from "./rpcs.ts";

class Api extends Context.Service<
  Api,
  RpcClient.FromGroup<typeof AppRpcs, RpcClientError.RpcClientError>
>()("app/Api") {
  static readonly layer = Layer.effect(Api)(RpcClient.make(AppRpcs)).pipe(
    Layer.provide(RendererRpcClient.layerProtocol()),
  );
}

const runtime = ManagedRuntime.make(Api.layer);

const version = await runtime.runPromise(
  Effect.gen(function* () {
    const api = yield* Api;
    return yield* api.GetVersion();
  }),
);

await runtime.runPromise(
  Effect.gen(function* () {
    const api = yield* Api;
    yield* api
      .Download({ url })
      .pipe(Stream.runForEach((progress) => Effect.sync(() => render(progress))));
  }),
);
```

## Why MessagePorts

Every connection is its own
[`MessagePort`](https://www.electronjs.org/docs/latest/tutorial/message-ports).
The page creates a `MessageChannel`, the preload forwards one end to main, and
from then on the page and main talk over the port directly. That choice is
what makes the rest simple:

- **Disconnects are free.** When a page reloads, navigates, crashes or its
  window closes, Electron closes its port. The server sees the client
  disconnect and interrupts everything it had in flight: handlers, streams,
  their finalizers. Nothing has to watch `webContents` events.
- **Ordered and duplex.** Effect RPC's protocol is a stream of messages in both
  directions: requests, stream chunks, acknowledgements and interrupts. A port
  carries exactly that. `ipcRenderer.invoke`, which is one request and one
  response, does not.
- **No serialization step.** RPC payloads are already schema-encoded, and ports
  copy messages with structured clone, so envelopes are posted as they are.
- **Nothing to keep in sync.** There is one IPC channel, used only to hand
  over ports, and it is internal. The page can reach nothing else through the
  bridge. Endpoints are plain names (`"default"` unless you choose one).
- **Other processes work the same way.** A port can be handed to a utility
  process, so a renderer can talk to one directly while main does no relaying.

The bridge does not use `contextBridge`, because `contextBridge` cannot carry a
`MessagePort`. It listens for `window.postMessage` requests from the page
itself (not from embedded frames) and forwards the port to main.

## Connection semantics

- **Before connecting.** Calls made before the connection is established wait
  for it. The client connects with a handshake and retries with backoff (100ms
  up to 2s by default, `retrySchedule` to change it). Each failed attempt is
  logged as a warning.
- **Established connection drops.** Calls in flight fail with an
  `RpcClientError` whose reason is a `SocketCloseError`: the server may or may
  not have run them, so they are not retried. The client reconnects, and later
  calls go through. A call started synchronously while that failure is being
  delivered (an `Effect.retry` with no delay, for example) fails with the same
  error ([Effect-TS/effect#8600](https://github.com/Effect-TS/effect/issues/8600)),
  so retry with a delay.
- **Refused connection.** The client does not retry. Pending and future calls
  fail with an `RpcClientError` whose reason is an `RpcClientDefect` carrying
  the reason for the refusal.
- **Interrupting a call.** This interrupts the handler on the server.
  Interrupting a call that is still waiting for the connection removes it: the
  server never sees it.
- **Streams.** Streams are backpressured. The server waits for the client to
  acknowledge each chunk, so a slow consumer holds the producer back, to within
  the client's stream buffer (16 items by default, the `streamBufferSize` call
  option).
- **Defects.** A defect in a handler fails only that call. Effect RPC's own
  default fails every call from the same client; `disableFatalDefects: false`
  restores it.

## Knowing who is calling

Handlers served from main can get the calling renderer by adding
`RendererSenderMiddleware` to the RPCs (or the group) and reading
`RendererSender`:

```ts
import { RendererSender, RendererSenderMiddleware } from "electron-effect-rpc";

export class WindowRpcs extends RpcGroup.make(Rpc.make("Minimize")).middleware(
  RendererSenderMiddleware,
) {}

WindowRpcs.toLayer({
  Minimize: () =>
    Effect.gen(function* () {
      const { webContents } = yield* RendererSender;
      BrowserWindow.fromWebContents(webContents)?.minimize();
    }),
});
```

`MainRpcServer.layer` provides the middleware. The sender is the `webContents`
and frame that opened the connection.

## Authorization

A renderer can use an endpoint once its preload has called `exposeRpcBridge()`.
Narrow that on either side:

```ts
// main: decide per connection (a boolean or an Effect<boolean>)
MainRpcServer.layer(AdminRpcs, {
  endpoint: "admin",
  authorize: ({ frame }) => frame?.url.startsWith("app://admin/") ?? false,
});

// preload: limit which endpoints this page can reach
exposeRpcBridge({ endpoints: ["default"] });
```

Refused renderers get an error for each call and do not reconnect.

## Utility processes

Serve a group from a utility process:

```ts
// worker.ts (utility process entry)
import { Effect, Layer } from "effect";
import { UtilityRpcServer } from "electron-effect-rpc/utility";

Effect.runFork(
  Layer.launch(UtilityRpcServer.layer(WorkerRpcs).pipe(Layer.provide(WorkerHandlers))),
);
```

Call it from main:

```ts
import { utilityProcess } from "electron";
import { UtilityRpcClient } from "electron-effect-rpc/main";

const child = utilityProcess.fork(WORKER_PATH);

const WorkerLive = Layer.effect(Worker)(RpcClient.make(WorkerRpcs)).pipe(
  Layer.provide(UtilityRpcClient.layerProtocol(child)),
);
```

When the utility process exits, in-flight calls fail and later calls fail
immediately instead of waiting to reconnect.

Or let renderers call it directly. Main hands each renderer's port to the
utility process and relays nothing:

```ts
// main
MainRpcServer.layerForward({ endpoint: "worker", target: child });

// renderer
RendererRpcClient.layerProtocol({ endpoint: "worker" });
```

## Several groups or endpoints

One endpoint serves one group; combine groups with `RpcGroup.merge`, or serve
them on separate endpoints:

```ts
Layer.mergeAll(
  MainRpcServer.layer(AppRpcs),
  MainRpcServer.layer(SettingsRpcs, { endpoint: "settings" }),
);
```

## Binary data

Effect RPC encodes payloads with each schema's JSON codec, which turns a
`Uint8Array` into base64. Structured clone can carry bytes as they are, so use
`Transferable.Uint8Array` from `effect/unstable/workers` for large binary
fields. It skips the JSON codec and leaves the value untouched.

## Custom topologies

`PortProtocol` (from the root entry point) is the transport underneath: an
`RpcServer.Protocol` that accepts ports, and an `RpcClient.Protocol` that
connects with any effect producing a port. Use it for ports you move around
yourself, for example between two renderers or into a web worker.

## Development

```sh
bun test              # protocol behavior over in-memory ports, including generated histories (PROPERTY_RUNS=1000 for a deeper search)
bun run test:electron # the transport in real Electron: sandboxed renderers, reloads, crashes, utility processes
bun run test:types
bun run lint
```

## License

MIT
