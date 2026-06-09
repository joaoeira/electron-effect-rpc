# Changelog

## Unreleased

### Breaking

- Schemas now come from `effect/Schema` (Effect core) instead of the deprecated
  `@effect/schema` package. The `@effect/schema` peer dependency was removed and
  the `effect` peer floor raised to `>=3.10.0`. Update contract imports:

  ```ts
  // before
  import * as S from "@effect/schema/Schema";
  // after
  import * as S from "effect/Schema";
  ```

- `event()` no longer accepts a third `context` schema argument. It was never
  read by the publisher or subscriber; remove it from any `event(...)` calls.
- `channelPrefix.rpc` and `channelPrefix.event` must now differ; identical
  prefixes throw at construction time.
- Providing `streamHandlers` when the contract defines no `streamMethods` now
  throws instead of being silently ignored.
- Methods whose request schema type is `object` (e.g. `S.Object`) now require
  an argument at the call site; previously the client generated a zero-arg
  caller that always sent `{}`.

### Added

- Handlers (unary and stream) receive an optional second `context` argument:
  `{ sender: WebContentsLike | null }`.
- `EventSubscriber.stream(event)` — Effect-native event consumption as a
  `Stream` that unsubscribes when its scope closes.
- `ipc.renderer(bridge, { diagnostics })` — renderer-side diagnostics hooks for
  RPC, events, and streams in kit mode.
- `assertValidChannelPrefix` exported from `electron-effect-rpc/types`.

### Fixed

- Main-side stream fibers no longer leak when the renderer goes away without
  cancelling: a destroyed sender now terminates the pipeline on the next chunk,
  and when the real Electron `WebContents` emitter is available the fiber is
  interrupted immediately on `destroyed`.
- Normally-completed streams no longer send a redundant `stream-cancel` invoke.
- `isNoErrorSchema` now matches `Never` schemas by AST tag, so a duplicated
  schema package instance can't silently turn typed failures into defects.
- Stream failure-encoding defects now carry the encoding error message instead
  of `[object Object]`.

## 0.8.0 and earlier

`getWindow` was renamed to `getWindows` and now returns an array, enabling
multi-window event fan-out. Empty array replaces `null` for "no windows."

Before:

```ts
getWindow: () => mainWindow,
```

After:

```ts
getWindows: () => [mainWindow],
```

Renderer RPC methods now return `Effect.Effect` instead of `Promise`, and
`IpcMainHandle.emit` was removed in favor of `publish`.

Before:

```ts
const result = await client.GetAppVersion();
await mainRpc.emit(WorkUnitProgress, payload);
```

After:

```ts
const result = await Effect.runPromise(client.GetAppVersion());
await Effect.runPromise(mainRpc.publish(WorkUnitProgress, payload));
```
