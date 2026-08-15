# ADR-0009: Streaming RPC with Fixed-Channel Protocol

**Status:** Accepted

## Context

`electron-effect-rpc` supports request-response RPC and fire-and-forget events,
but has no mechanism for long-running operations that emit multiple values over
time (e.g., AI token streaming, file processing progress). Electron's
`ipcMain.handle`/`ipcRenderer.invoke` is limited to a single response per
request. Supporting multi-frame responses requires combining `invoke` for the
handshake with `webContents.send` for data frames.

## Decision

We add streaming RPC as a new contract primitive (`streamRpc()`) alongside `rpc()`
and `event()`. The protocol uses:

1. **Renderer-generated streamId:** The renderer generates a UUID and registers
   its frame dispatcher before calling `invoke`. This eliminates the race
   condition where main forks a Fiber and emits frames before the renderer's
   `.then()` callback sets up a listener.

2. **Fixed shared channels:** All stream frames flow through one channel per
   direction (`rpc/sf` for frames, `rpc/stream-cancel` for cancellation), with
   `streamId` in the payload. This avoids per-stream listener registration,
   works with the `channelPrefix` system, and simplifies cleanup to
   `map.delete()` rather than listener removal.

3. **Cancel via invoke:** Cancellation uses `ipcMain.handle`/`ipcRenderer.invoke`
   rather than fire-and-forget `send`. This keeps `IpcMainLike` unchanged at
   `{ handle, removeHandler }` with no new `on`/`removeListener` surface.

4. **Separate handler maps:** `handlers` maps to `Effect`-returning functions,
   `streamHandlers` maps to `Stream`-returning functions. No union types or
   conditional mapped types.

5. **Stream.callback on renderer:** The Effect v4 renderer client uses
   `Stream.callback` with its queue APIs and `Effect.addFinalizer` for
   deterministic cleanup on all exit paths (success, failure, interruption).
   Buffer policy is configurable per stream client (`streamBuffer`) and defaults
   to `bufferSize: "unbounded"` for lossless delivery. Bounded policies are lossy
   for chunks, while queue completion and failure signals remain reliable.

## Consequences

- `RpcContract` gains a third type parameter `StreamMethods` (defaults to `readonly []`).
- `RpcEndpointOptions` gains an optional `streamHandlers` field.
- The preload bridge gains `onStreamFrame` for receiving stream frames.
- `IpcMainLike` is unchanged. Existing test mocks work without modification.
- Reserved name validation prevents collision with internal channels (`sf`,
  `stream-cancel`, `stream/*` prefix).
- Four new `RpcDefectCode` values: `stream_invoke_failed`,
  `stream_handshake_invalid`, `stream_chunk_decode_failed`,
  `stream_error_decode_failed`.
- Three new `DecodeFailureScope` values: `stream-request`, `stream-chunk`,
  `stream-error`.
