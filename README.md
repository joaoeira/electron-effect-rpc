# electron-effect-rpc

Typed IPC RPC for Electron, built on Effect and `effect/Schema`.

The ergonomic default is now a single shared `createIpcKit` configuration that
you reuse in main, preload, and renderer code. Low-level subpath APIs still
exist and remain fully supported.

This package is ESM-only. It targets modern Electron runtimes and assumes an
ESM-capable build pipeline.

## Features

- Single shared contract for methods, events, and streaming RPC.
- Single shared kit config to eliminate cross-process prefix drift.
- End-to-end schema validation at IPC boundaries.
- Effect-first renderer RPC with typed domain and defect channels.
- Streaming RPC: handlers return `Stream.Stream`, clients consume `Stream.Stream`.
- Effect-native main handlers with explicit runtime injection.
- Explicit lifecycle handles and bounded event queue backpressure.
- Structured diagnostics hooks for decode/protocol/dispatch failures.

## Requirements

- Electron with context isolation enabled.
- ESM-capable bundling.
- Peer dependencies: `effect` (>=3.10), `electron`.

## Installation

```sh
bun add electron-effect-rpc effect
```

## Quickstart (Kit-First)

### 1) Define contract and kit once

```ts
import * as S from "effect/Schema";
import { createIpcKit, defineContract, event, rpc, streamRpc } from "electron-effect-rpc";

export const GetAppVersion = rpc("GetAppVersion", S.Struct({}), S.Struct({ version: S.String }));

export const WorkUnitProgress = event(
  "WorkUnitProgress",
  S.Struct({
    requestId: S.String,
    chunk: S.String,
    done: S.Boolean,
  }),
);

export const StreamAiGeneration = streamRpc(
  "StreamAiGeneration",
  S.Struct({ prompt: S.String }),
  S.Struct({ delta: S.String }),
);

const contract = defineContract({
  methods: [GetAppVersion] as const,
  events: [WorkUnitProgress] as const,
  streamMethods: [StreamAiGeneration] as const,
});

export const ipc = createIpcKit({
  contract,
  channelPrefix: { rpc: "rpc/", event: "event/" },
  bridge: { global: "api" },
  decode: { rpc: "envelope", events: "safe" },
});
```

### 2) Main process

```ts
import path from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import { Effect, Stream } from "effect";
import * as Runtime from "effect/Runtime";
import { ipc, WorkUnitProgress } from "./shared-ipc.ts";

const mainWindow = new BrowserWindow({
  webPreferences: { preload: path.join(import.meta.dirname, "preload.js") },
});

const mainRpc = ipc.main({
  ipcMain,
  handlers: {
    GetAppVersion: () => Effect.succeed({ version: app.getVersion() }),
    // Handlers may take an optional second argument with request context:
    // GetAppVersion: (_input, { sender }) => ...
  },
  streamHandlers: {
    StreamAiGeneration: ({ prompt }) =>
      Stream.fromIterable(prompt.split(" ")).pipe(Stream.map((word) => ({ delta: word + " " }))),
  },
  runtime: Runtime.defaultRuntime,
  getWindows: () => [mainWindow],
});

mainRpc.start();

void Effect.runPromise(
  mainRpc.publish(WorkUnitProgress, {
    requestId: "req-1",
    chunk: "starting",
    done: false,
  }),
);
```

### 3) Preload

```ts
import { ipc } from "./shared-ipc.ts";

const { expose } = ipc.preload();
expose();
```

This exposes one global by default: `window.api`.

If your preload runtime is ESM-only and does not expose synchronous `require`,
pass the imported Electron module explicitly:

```ts
import * as electron from "electron";
import { ipc } from "./shared-ipc.ts";

const { expose } = ipc.preload({ electronModule: electron });
expose();
```

### 4) Renderer

```ts
import { Effect, Stream } from "effect";
import { ipc, WorkUnitProgress } from "./shared-ipc.ts";

const { client, events, streamClient, dispose } = ipc.renderer(window.api);
const { version } = await Effect.runPromise(client.GetAppVersion());

// Streaming RPC
await Effect.runPromise(
  streamClient
    .StreamAiGeneration({ prompt: "hello world" })
    .pipe(Stream.runForEach((chunk) => Effect.sync(() => console.log(chunk.delta)))),
);

const unsubscribe = events.subscribe(WorkUnitProgress, (payload) => {
  console.log(payload.chunk);
});

// Or consume events as an Effect Stream (unsubscribes when the scope closes):
await Effect.runPromise(
  events
    .stream(WorkUnitProgress)
    .pipe(Stream.runForEach((payload) => Effect.sync(() => console.log(payload.chunk)))),
);

// later
unsubscribe();
dispose();
```

Renderer-side diagnostics hooks are available through the second argument:

```ts
const renderer = ipc.renderer(window.api, {
  diagnostics: {
    rpc: { onDecodeFailure: (ctx) => console.warn("rpc decode failure", ctx) },
    events: { onDecodeFailure: (ctx) => console.warn("event decode failure", ctx) },
  },
});
```

### 5) Window typing

Use the exported `IpcBridgeGlobal` helper so the declared shape stays in sync
with what `ipc.preload()` exposes:

```ts
import type { IpcBridgeGlobal } from "electron-effect-rpc";

declare global {
  interface Window extends IpcBridgeGlobal {}
}
```

For a custom global name, use `IpcBridgeGlobal<"myBridge">`.

## Error Model

Domain failures are modeled with tagged error schemas and are surfaced in the
Effect error channel as those same tagged values. Unexpected failures,
transport defects, and protocol mismatches are surfaced as `RpcDefectError`,
which includes a stable `code` discriminator:
`request_encoding_failed`, `invoke_failed`,
`success_payload_decoding_failed`, `failure_payload_decoding_failed`,
`noerror_contract_violation`, `invalid_response_envelope`,
`legacy_decode_failed`, `remote_defect`,
`stream_invoke_failed`, `stream_handshake_invalid`,
`stream_chunk_decode_failed`, and `stream_error_decode_failed`.

Defect envelopes carry the main-process error message verbatim across IPC. If
any window in your app loads remote or less-trusted content, treat that as
information disclosure: catch and sanitize errors in your handlers rather than
letting raw exceptions (paths, query fragments) become defects.

## Operational Notes

**Stream backpressure.** Stream frames are pushed from main as fast as the
handler produces them; there is no acknowledgment across the IPC boundary. The
renderer buffers with `bufferSize: "unbounded"` by default, which is lossless
but means a fast producer with a slow consumer grows renderer memory. Bounded
buffers (`dropping`/`sliding`) are lossy by design and, with current Effect
`Stream.asyncPush` internals, can lose terminal signals under sustained
pressure. Rate-limit fast producers in the handler (`Stream.throttle`,
batching) rather than relying on a bounded renderer buffer.

**Unary RPC cancellation.** Interrupting the renderer-side Effect of a
client call (e.g. via `Effect.timeout`) does not abort the main-side handler;
the underlying `ipcRenderer.invoke` is not abortable. The handler runs to
completion and its response is discarded. Streaming RPC does propagate
cancellation to main. If a unary handler does expensive work, model it as a
stream or build explicit cancellation into your contract.

**Renderer teardown.** Main interrupts a stream's fiber when the renderer's
`webContents` is destroyed (immediately when the real Electron `WebContents`
event emitter is available, otherwise on the next chunk), so handler fibers do
not outlive closed windows.

## Migration Notes

See [CHANGELOG.md](./CHANGELOG.md) for breaking changes between versions.

## Low-Level APIs (Still Supported)

If you need direct control, keep using subpath entry points:

- `electron-effect-rpc/contract`
- `electron-effect-rpc/main`
- `electron-effect-rpc/renderer`
- `electron-effect-rpc/preload`
- `electron-effect-rpc/types`
- `electron-effect-rpc/testing`

## Root API Surface

The root entry point exports:

- `createIpcKit`
- `rpc`, `event`, `streamRpc`, `defineContract`, `NoError`
- Types: `IpcKit`, `IpcKitOptions`, `IpcMainHandle`, `IpcBridge`, `IpcBridgeGlobal`

Low-level factories like `createRpcClient` remain subpath-only by design.

## Tutorials

For deeper walkthroughs and production guidance:

- [Tutorial Index](./docs/tutorials/README.md)
- [First RPC: Main + Preload + Renderer](./docs/tutorials/01-first-rpc.md)
- [Typed Errors, Defects, and Diagnostics](./docs/tutorials/02-typed-errors-defects-diagnostics.md)
- [Events, Lifecycle, and Backpressure](./docs/tutorials/03-events-lifecycle-backpressure.md)
- [Streaming RPC](./docs/tutorials/04-streaming-rpc.md)

## Conventions

- Relative imports use `.ts` extensions.
- Package imports are extensionless.
- No `index.ts` barrel files in subpath modules.

## License

MIT
