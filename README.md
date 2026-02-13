# electron-effect-rpc

Typed IPC RPC for Electron, built on Effect and @effect/schema.

The ergonomic default is now a single shared `createIpcKit` configuration that
you reuse in main, preload, and renderer code. Low-level subpath APIs still
exist and remain fully supported.

This package is ESM-only. It targets modern Electron runtimes and assumes an
ESM-capable build pipeline.

## Features
- Single shared contract for methods and events.
- Single shared kit config to eliminate cross-process prefix drift.
- End-to-end schema validation at IPC boundaries.
- Promise-based renderer RPC with typed domain errors.
- Effect-native main handlers with explicit runtime injection.
- Explicit lifecycle handles and bounded event queue backpressure.
- Structured diagnostics hooks for decode/protocol/dispatch failures.

## Requirements
- Electron with context isolation enabled.
- ESM-capable bundling.
- Peer dependencies: `effect`, `@effect/schema`, `electron`.

## Installation
```sh
bun add electron-effect-rpc effect @effect/schema
```

## Quickstart (Kit-First)

### 1) Define contract and kit once
```ts
import * as S from "@effect/schema/Schema";
import { createIpcKit, defineContract, event, rpc } from "electron-effect-rpc";

export const GetAppVersion = rpc(
  "GetAppVersion",
  S.Struct({}),
  S.Struct({ version: S.String })
);

export const WorkUnitProgress = event(
  "WorkUnitProgress",
  S.Struct({
    requestId: S.String,
    chunk: S.String,
    done: S.Boolean,
  })
);

const contract = defineContract({
  methods: [GetAppVersion] as const,
  events: [WorkUnitProgress] as const,
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
import { app, ipcMain } from "electron";
import { Effect } from "effect";
import * as Runtime from "effect/Runtime";
import { ipc, WorkUnitProgress } from "./shared-ipc.ts";

const mainRpc = ipc.main({
  ipcMain,
  handlers: {
    GetAppVersion: () => Effect.succeed({ version: app.getVersion() }),
  },
  runtime: Runtime.defaultRuntime,
  getWindow: () => mainWindow,
});

mainRpc.start();

void mainRpc.emit(WorkUnitProgress, {
  requestId: "req-1",
  chunk: "starting",
  done: false,
});

// Effect-native alternative:
// void Effect.runPromise(mainRpc.publish(WorkUnitProgress, {...}));
```

### 3) Preload
```ts
import { ipc } from "./shared-ipc.ts";

ipc.preload().expose();
```

This exposes one global by default: `window.api`.

### 4) Renderer
```ts
import { ipc, WorkUnitProgress } from "./shared-ipc.ts";

const { client, events } = ipc.renderer(window.api);
const { version } = await client.GetAppVersion();

const unsubscribe = events.subscribe(WorkUnitProgress, (payload) => {
  console.log(payload.chunk);
});

// later
unsubscribe();
events.dispose();
```

### 5) Window typing
```ts
declare global {
  interface Window {
    api: {
      invoke: (method: string, payload: unknown) => Promise<unknown>;
      subscribe: (name: string, handler: (payload: unknown) => void) => () => void;
    };
  }
}
```

## Error Model

Domain failures are modeled with tagged error schemas and are re-thrown in the
renderer as those same error classes. Unexpected failures, transport defects,
and protocol mismatches are surfaced as `RpcDefectError`.

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
- `rpc`, `event`, `defineContract`, `NoError`
- Types: `IpcKit`, `IpcKitOptions`, `IpcMainHandle`, `IpcBridge`, `IpcBridgeGlobal`

Low-level factories like `createRpcClient` remain subpath-only by design.

## Tutorials

For deeper walkthroughs and production guidance:
- [Tutorial Index](./docs/tutorials/README.md)
- [First RPC: Main + Preload + Renderer](./docs/tutorials/01-first-rpc.md)
- [Typed Errors, Defects, and Diagnostics](./docs/tutorials/02-typed-errors-defects-diagnostics.md)
- [Events, Lifecycle, and Backpressure](./docs/tutorials/03-events-lifecycle-backpressure.md)

## Conventions
- Relative imports use `.ts` extensions.
- Package imports are extensionless.
- No `index.ts` barrel files in subpath modules.

## License
MIT
