# electron-effect-rpc

Typed IPC RPC for Electron, built on Effect and @effect/schema. This library
lets you define a shared contract, generate a typed RPC client in the renderer,
register handlers in the main process, and stream typed events across processes.

This package is ESM-only. It targets modern Electron runtimes (current project
uses Electron 38) and assumes ESM-capable bundling.

## Features
- Single shared contract for methods and events.
- End-to-end type safety using @effect/schema.
- Promise-based renderer client with typed errors.
- Effect-based main handlers with optional runtime injection.
- Event bus and subscriber for typed renderer events.
- No protocol handshake or versioning; schema decoding is the source of truth.

## Requirements
- Electron with context isolation enabled.
- ESM-capable build pipeline.
- Peer dependencies: `effect`, `@effect/schema`, `electron`.

## Installation
```sh
bun add electron-effect-rpc effect @effect/schema
```

If you are in a monorepo workspace, add the dependency to the target package
and let the workspace resolver handle the rest.

## Core Concepts

### Methods and events
Define methods and events using schema-based helpers:

```ts
import * as S from "@effect/schema/Schema";
import { defineContract, event, rpc } from "electron-effect-rpc/contract";

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

const methods = [GetAppVersion] as const;
const events = [WorkUnitProgress] as const;

export const contract = defineContract({ methods, events });
```

### Errors
Error schemas should be `Schema.TaggedError` classes. If a method does not
declare an error schema, it uses `NoError` and the error channel is `never`.

```ts
import * as S from "@effect/schema/Schema";
import { rpc } from "electron-effect-rpc/contract";

export class FileReadError extends S.TaggedError<FileReadError>()("FileReadError", {
  message: S.String,
  path: S.String,
}) {}

export const ReadTextFile = rpc(
  "ReadTextFile",
  S.Struct({ path: S.String }),
  S.Struct({ content: S.String }),
  FileReadError
);
```

## Usage

### Main process: register handlers
```ts
import { app, ipcMain } from "electron";
import { Effect } from "effect";
import { createRpcServer, createEventBus } from "electron-effect-rpc/main";
import { contract, WorkUnitProgress } from "./contract.ts";

const implementations = {
  GetAppVersion: () => Effect.succeed({ version: app.getVersion() }),
};

createRpcServer(contract, ipcMain, implementations);

const eventBus = createEventBus(contract, {
  getWindow: () => mainWindow,
});

eventBus.emit(WorkUnitProgress, {
  requestId: "req-1",
  chunk: "working...",
  done: false,
});
```

If your handlers require services in the Effect environment, provide a runtime:

```ts
import * as Runtime from "effect/Runtime";
import { createRpcServer } from "electron-effect-rpc/main";
import { contract } from "./contract.ts";

createRpcServer(contract, ipcMain, implementations, {
  runtime: Runtime.defaultRuntime,
});
```

### Preload: expose bridge globals
```ts
import { exposeRpcBridge } from "electron-effect-rpc/preload";

exposeRpcBridge();
```

Defaults:
- RPC global: `window.rpc.invoke(method, payload)`
- Events global: `window.events.subscribe(name, handler)`
- Channel prefix: `rpc/` and `event/`

You can override globals and prefixes:
```ts
exposeRpcBridge({
  rpcGlobal: "rpcApi",
  eventsGlobal: "rpcEvents",
  channelPrefix: { rpc: "rpc/", event: "events/" },
});
```

### Renderer: create client and subscriber
```ts
import { createRpcClient, createEventSubscriber } from "electron-effect-rpc/renderer";
import { contract, WorkUnitProgress } from "./contract.ts";

const client = createRpcClient(contract, { invoke: window.rpc.invoke });
const events = createEventSubscriber(contract, { subscribe: window.events.subscribe });

const { version } = await client.GetAppVersion();

events.subscribe(WorkUnitProgress, (payload) => {
  console.log(payload.chunk);
});
```

### Window type augmentation
If you expose globals in preload, add a local `globals.d.ts`:

```ts
declare global {
  interface Window {
    rpc: {
      invoke: (method: string, payload: unknown) => Promise<unknown>;
    };
    events: {
      subscribe: (name: string, handler: (payload: unknown) => void) => () => void;
    };
  }
}
```

## Testing

### Renderer client tests
Use the testing helpers to stub invoke behavior:

```ts
import { createRpcClient } from "electron-effect-rpc/renderer";
import { createInvokeStub } from "electron-effect-rpc/testing";
import { contract } from "./contract.ts";

const invoke = createInvokeStub(async (method, payload) => {
  // return encoded Exit values from your handler logic
  return payload;
});

const client = createRpcClient(contract, { invoke });
await client.GetAppVersion();

expect(invoke.invocations).toEqual([
  { method: "GetAppVersion", payload: {} },
]);
```

### Main process tests
You can stub `IpcMainLike` and collect registered handlers:

```ts
import { createRpcServer } from "electron-effect-rpc/main";
import type { IpcMainLike } from "electron-effect-rpc/types";
import { contract } from "./contract.ts";

const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
const ipcMainStub: IpcMainLike = {
  handle: (channel, handler) => {
    handlers.set(channel, handler);
  },
};

createRpcServer(contract, ipcMainStub, implementations);
```

## Error Handling
- If a handler fails with a typed domain error, the renderer client rejects
  with that error instance.
- If a handler dies or throws a defect, the renderer client rejects with
  `RpcDefectError`.

## API Surface

Entry points:
- `electron-effect-rpc/contract`
  - `rpc`, `event`, `defineContract`, `exitSchemaFor`, `SchemaNoContext`, `NoError`
- `electron-effect-rpc/types`
  - Type aliases such as `Implementations`, `RpcClient`, `RpcEventBus`, `IpcMainLike`
- `electron-effect-rpc/main`
  - `createRpcServer`, `createEventBus`
- `electron-effect-rpc/renderer`
  - `createRpcClient`, `createEventSubscriber`, `RpcDefectError`
- `electron-effect-rpc/preload`
  - `exposeRpcBridge`
- `electron-effect-rpc/testing`
  - `createInvokeStub`, `createDeferred`

## Conventions
- Relative imports use `.ts` extensions.
- Package imports are extensionless.
- No `index.ts` barrel files.

## License
MIT
