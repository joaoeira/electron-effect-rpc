# 01 - First RPC: Main + Preload + Renderer

This walkthrough builds one RPC method and one event end to end so you can
verify your integration shape before your app grows.

The target result is simple: the renderer calls `GetAppVersion` and subscribes
to `WorkUnitProgress`, while main process code handles the RPC and publishes the
event.

## Step 1: Define a shared contract

Put your contract in a module imported by both main and renderer code.

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

export const contract = defineContract({
  methods: [GetAppVersion] as const,
  events: [WorkUnitProgress] as const,
});
```

`defineContract` gives you a single source of truth for names and schemas, and
it rejects duplicate names at runtime.

## Step 2: Register RPC handlers and event publisher in main

Create an endpoint and a publisher during app startup, then explicitly call
`start()` on both.

```ts
import { app, ipcMain } from "electron";
import { Effect } from "effect";
import * as Runtime from "effect/Runtime";
import { createEventPublisher, createRpcEndpoint } from "electron-effect-rpc/main";
import { contract, WorkUnitProgress } from "./contract.ts";

const endpoint = createRpcEndpoint(
  contract,
  ipcMain,
  {
    GetAppVersion: () =>
      Effect.succeed({
        version: app.getVersion(),
      }),
  },
  {
    runtime: Runtime.defaultRuntime,
  }
);

const publisher = createEventPublisher(contract, {
  getWindow: () => mainWindow,
});

endpoint.start();
publisher.start();

void Effect.runPromise(
  publisher.publish(WorkUnitProgress, {
    requestId: "req-1",
    chunk: "starting",
    done: false,
  })
);
```

You must provide a runtime in `createRpcEndpoint`. That is deliberate: runtime
ownership stays explicit instead of being hidden in global state.

## Step 3: Expose a narrow preload bridge

In preload, expose just the invoke and subscribe surface.

```ts
import { exposeRpcBridge } from "electron-effect-rpc/preload";

exposeRpcBridge();
```

By default, this exposes:

- `window.rpc.invoke(method, payload)`
- `window.events.subscribe(name, handler)`

If you customize channel prefixes or global names, configure the same values
consistently in main, preload, and renderer.

## Step 4: Create renderer client and subscriber

In renderer code, build typed helpers from the same contract.

```ts
import { Effect } from "effect";
import { createEventSubscriber, createRpcClient } from "electron-effect-rpc/renderer";
import { contract, WorkUnitProgress } from "./contract.ts";

const client = createRpcClient(contract, {
  invoke: window.rpc.invoke,
});

const events = createEventSubscriber(contract, {
  subscribe: window.events.subscribe,
  decodeMode: "safe",
});

const result = await Effect.runPromise(client.GetAppVersion());
console.log(result.version);

const unsubscribe = events.subscribe(WorkUnitProgress, (payload) => {
  console.log(payload.requestId, payload.chunk, payload.done);
});

// later
unsubscribe();
events.dispose();
```

At this point you have typed request/response calls, typed events, and runtime
schema validation at IPC boundaries.

## Step 5: Wire lifecycle cleanup

On shutdown, stop and dispose endpoint/publisher instances in main process
teardown hooks. On renderer teardown, dispose event subscribers. The package
lifecycle handles are idempotent, so repeated stop/dispose calls are safe.

## Common integration mistake

If RPC calls hang or fail with channel errors, check prefix alignment first.
Main registration, preload bridge, and renderer invoke/subscribe must all agree
on channel naming.
