# 04 - Streaming RPC

Standard RPC methods return a single response. Streaming RPC methods return
multiple values over time as an Effect `Stream`. This is useful for AI token
generation, file processing, or any operation where the main process produces
results incrementally.

## Step 1: Define a stream method in the contract

Use `streamRpc()` instead of `rpc()`. The third argument is the chunk schema
(each frame's payload), not a response schema.

```ts
import * as S from "@effect/schema/Schema";
import { defineContract, rpc, streamRpc } from "electron-effect-rpc/contract";

class AiError extends S.TaggedError<AiError>()("AiError", {
  message: S.String,
}) {}

export const StreamAiGeneration = streamRpc(
  "StreamAiGeneration",
  S.Struct({ prompt: S.String }), // request
  S.Struct({ delta: S.String }), // chunk (each frame)
  AiError, // typed error (optional)
);

export const Ping = rpc("Ping", S.Struct({}), S.Struct({ ok: S.Boolean }));

export const contract = defineContract({
  methods: [Ping] as const,
  events: [] as const,
  streamMethods: [StreamAiGeneration] as const,
});
```

`defineContract` validates that no name appears in both `methods` and
`streamMethods`, and rejects names that collide with internal transport channels
(`sf`, `stream-cancel`, or anything starting with `stream/`).

## Step 2: Implement the stream handler in main

Stream handlers return `Stream.Stream<Chunk, Err, R>` instead of
`Effect.Effect<Res, Err, R>`. They go in a separate `streamHandlers` field.

```ts
import { Effect, Stream } from "effect";
import * as Runtime from "effect/Runtime";
import { createRpcEndpoint } from "electron-effect-rpc/main";
import { contract, AiError } from "./contract.ts";

const endpoint = createRpcEndpoint(
  contract,
  ipcMain,
  {
    Ping: () => Effect.succeed({ ok: true }),
  },
  {
    runtime: Runtime.defaultRuntime,
    streamHandlers: {
      StreamAiGeneration: ({ prompt }) =>
        generateTokens(prompt).pipe(Stream.map((token) => ({ delta: token }))),
    },
  },
);

endpoint.start();
```

If the contract defines `streamMethods` but you omit `streamHandlers`, the
endpoint throws at construction time.

Stream handlers have access to the same Effect services as regular RPC handlers
through the injected runtime.

## Step 3: Expose the stream frame channel in preload

The preload bridge automatically exposes `onStreamFrame` alongside `invoke` and
`subscribe` when you use `exposeIpcBridge` or `exposeRpcBridge`.

```ts
import { exposeIpcBridge } from "electron-effect-rpc/preload";

exposeIpcBridge();
```

If you use `createBridgeAdapters` directly, the returned object includes
`onStreamFrame`.

## Step 4: Consume the stream in the renderer

Stream callers return `Stream.Stream<Chunk, Error>`. Consume them with any
Effect stream operator.

```ts
import { Effect, Stream } from "effect";
import { createStreamRpcClient } from "electron-effect-rpc/renderer";
import { contract } from "./contract.ts";

const streamHandle = createStreamRpcClient(contract, {
  invoke: window.api.invoke,
  onStreamFrame: window.api.onStreamFrame!,
});

// Collect all chunks
const allChunks = await Effect.runPromise(
  streamHandle.client.StreamAiGeneration({ prompt: "hello" }).pipe(
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  ),
);

// Process each chunk as it arrives
await Effect.runPromise(
  streamHandle.client
    .StreamAiGeneration({ prompt: "hello" })
    .pipe(Stream.runForEach((chunk) => Effect.sync(() => console.log(chunk.delta)))),
);

// Take only the first 5 chunks (stream is cancelled automatically)
await Effect.runPromise(
  streamHandle.client
    .StreamAiGeneration({ prompt: "hello" })
    .pipe(Stream.take(5), Stream.runCollect),
);

// Clean up when done
streamHandle.dispose();
```

## Using the kit

With `createIpcKit`, streaming is wired automatically. The renderer return
value includes `streamClient` alongside `client` and `events`.

```ts
const { client, events, streamClient, dispose } = ipc.renderer(window.api);

await Effect.runPromise(
  streamClient
    .StreamAiGeneration({ prompt: "hello" })
    .pipe(Stream.runForEach((chunk) => Effect.sync(() => appendToUI(chunk.delta)))),
);

// dispose() cleans up both event subscribers and stream client
dispose();
```

## Error handling

Stream errors work the same way as regular RPC errors. Typed domain errors
appear in the stream's error channel. Transport defects appear as
`RpcDefectError`.

```ts
await Effect.runPromise(
  streamClient.StreamAiGeneration({ prompt: "hello" }).pipe(
    Stream.runForEach((chunk) => Effect.sync(() => appendToUI(chunk.delta))),
    Effect.catchTag("AiError", (e) => Effect.sync(() => showError(e.message))),
    Effect.catchTag("RpcDefectError", (e) =>
      Effect.sync(() => showError(`Transport error: ${e.code}`)),
    ),
  ),
);
```

Stream-specific defect codes:

- `stream_invoke_failed` — the handshake invoke call failed.
- `stream_handshake_invalid` — main returned an unrecognized handshake response.
- `stream_chunk_decode_failed` — a data frame's payload failed schema decoding.
- `stream_error_decode_failed` — an error frame's payload failed schema decoding.

## Cancellation

Streams are cancelled automatically when the consumer stops pulling. For
example, `Stream.take(5)` cancels the stream after 5 chunks. The renderer
sends a cancel to main via `invoke`, and main interrupts the Fiber.

Cancellation after natural completion is harmless. Main's cancel handler checks
the `activeStreams` map, finds no entry (already cleaned up), and returns
`{ cancelled: false }`.

## Lifecycle

Stream lifecycle integrates with the existing start/stop/dispose model:

- **Main `stop()`:** Interrupts all active stream Fibers, clears the active
  streams map, then removes all handlers.
- **Main `dispose()`:** Calls `stop()` then marks as disposed.
- **Renderer `streamHandle.dispose()`:** Fails all active stream consumers with
  a defect, then removes the central frame listener.
- **Kit `dispose()`:** Calls stream client `dispose()` on the renderer side.

## Concurrent streams

Multiple streams can run simultaneously. Each has its own `streamId`, its own
Fiber on main, and its own entry in the renderer's frame dispatcher. There is
no shared mutable state between streams beyond the maps themselves.

## Sender destruction

If a renderer window is destroyed while a stream is active, main detects this
via the `isDestroyed()` check and stops sending frames. The Fiber terminates
cleanly, and the active stream entry is removed.
