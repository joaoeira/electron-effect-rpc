# electron-effect-rpc

[![npm](https://img.shields.io/npm/v/electron-effect-rpc)](https://www.npmjs.com/package/electron-effect-rpc)

Typed, schema-validated IPC for Electron, built on [Effect](https://effect.website).

Define your IPC surface once — methods, events, and streams, each described
with `effect/Schema` — and get a fully typed client in the renderer, fully
typed handlers in main, and runtime validation at every process boundary. No
hand-rolled channel strings, no `any`-typed `invoke` calls, no drift between
processes.

The primary API is a single shared `createIpcKit` configuration reused across
main, preload, and renderer. Low-level per-piece factories remain available as
subpath imports.

This package is ESM-only. It targets modern Electron runtimes and assumes an
ESM-capable build pipeline.

## Features

- One contract for methods, events, and streaming RPC, shared by all three processes.
- One kit config, so channel naming can never drift between processes.
- Schema validation on every IPC crossing, in both directions.
- Typed domain errors in the Effect error channel; transport problems as `RpcDefectError` with stable codes.
- Streaming RPC: handlers return `Stream.Stream`, clients consume `Stream.Stream`, cancellation propagates.
- Main handlers are Effects, run on a runtime you inject (so your services/layers are available).
- Explicit lifecycle handles (`start`/`stop`/`dispose`) and bounded event queue backpressure.
- Structured diagnostics hooks for decode/protocol/dispatch failures.

## Requirements

- Electron >= 28 with context isolation enabled.
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

export const ipc = createIpcKit({ contract });
```

`createIpcKit` accepts optional configuration; the values below are the
defaults, so only set them to deviate:

```ts
export const ipc = createIpcKit({
  contract,
  channelPrefix: { rpc: "rpc/", event: "event/" },
  bridge: { global: "api" },
  decode: { rpc: "envelope", events: "safe" },
  streamBuffer: { bufferSize: "unbounded" },
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
app.on("will-quit", () => mainRpc.dispose());

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

A call site sees exactly two kinds of failure in the Effect error channel:

- **Domain failures** — the tagged errors you declared in the contract's error
  schema, decoded back into those same tagged values.
- **`RpcDefectError`** — everything else: transport problems, schema
  mismatches, and unexpected main-process exceptions. It is itself tagged
  (`_tag: "RpcDefectError"`) and carries a stable `code` discriminator.

```ts
import { Effect } from "effect";

const result = await Effect.runPromise(
  client.DeleteWorkspace({ id }).pipe(
    // a tagged error you declared in the contract
    Effect.catchTag("AccessDeniedError", (e) =>
      Effect.succeed({ deleted: false, reason: e.message }),
    ),
    // transport/contract problems
    Effect.catchTag("RpcDefectError", (defect) =>
      Effect.sync(() => log.error(defect.code, defect.message)).pipe(
        Effect.andThen(Effect.fail(defect)),
      ),
    ),
  ),
);
```

`RpcDefectError.code` values:

| Code                              | Meaning                                                             |
| --------------------------------- | ------------------------------------------------------------------- |
| `request_encoding_failed`         | Request payload failed schema encoding before leaving the renderer. |
| `invoke_failed`                   | The underlying `ipcRenderer.invoke` rejected (transport failure).   |
| `success_payload_decoding_failed` | Main's success payload failed response schema decoding.             |
| `failure_payload_decoding_failed` | Main's typed failure payload failed error schema decoding.          |
| `noerror_contract_violation`      | A failure arrived for a method that declares `NoError`.             |
| `invalid_response_envelope`       | The response was not a valid envelope.                              |
| `legacy_decode_failed`            | `dual` decode mode could not parse a legacy `Exit` payload.         |
| `remote_defect`                   | The main-side handler died, threw, or was interrupted.              |
| `stream_invoke_failed`            | The stream handshake invoke rejected (transport failure).           |
| `stream_handshake_invalid`        | The stream handshake response had an unexpected shape.              |
| `stream_chunk_decode_failed`      | A stream chunk failed schema decoding.                              |
| `stream_error_decode_failed`      | A stream's typed error frame failed schema decoding.                |

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

- `electron-effect-rpc/contract` — `rpc`, `event`, `streamRpc`, `defineContract`
- `electron-effect-rpc/main` — `createRpcEndpoint`, `createEventPublisher`
- `electron-effect-rpc/renderer` — `createRpcClient`, `createEventSubscriber`, `createStreamRpcClient`
- `electron-effect-rpc/preload` — `exposeIpcBridge`, `createBridgeAdapters`
- `electron-effect-rpc/types` — shared types, `RpcDefectError`, `assertValidChannelPrefix`
- `electron-effect-rpc/testing` — `createInvokeStub`, `createDeferred` for unit-testing clients without Electron

## Root API Surface

The root entry point exports:

- `createIpcKit`
- `rpc`, `event`, `streamRpc`, `defineContract`, `NoError`
- Types: `IpcKit`, `IpcKitOptions`, `IpcMainHandle`, `IpcBridge`, `IpcBridgeGlobal`

Low-level factories like `createRpcClient` remain subpath-only by design.

## Documentation

For deeper walkthroughs and production guidance:

- [Tutorial Index](./docs/tutorials/README.md)
- [First RPC: Main + Preload + Renderer](./docs/tutorials/01-first-rpc.md)
- [Typed Errors, Defects, and Diagnostics](./docs/tutorials/02-typed-errors-defects-diagnostics.md)
- [Events, Lifecycle, and Backpressure](./docs/tutorials/03-events-lifecycle-backpressure.md)
- [Streaming RPC](./docs/tutorials/04-streaming-rpc.md)
- [Architecture overview](./docs/architecture.md) and [ADRs](./docs/adr/) for design rationale.

## Repository Conventions

- Relative imports use `.ts` extensions.
- Package imports are extensionless.
- No `index.ts` barrel files in subpath modules.

## License

MIT
