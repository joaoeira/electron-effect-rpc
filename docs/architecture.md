# Architecture

`electron-effect-rpc` is organized around one idea: every IPC boundary should be
described once, validated at runtime, and surfaced as typed APIs on both sides
of the Electron split. The shared contract in `src/contract.ts` is the center of
that model. Main process code uses it to register handlers and publish events;
renderer code uses the same definitions to call methods and subscribe to events.
The preload layer exists only to bridge Electron's IPC primitives into a narrow,
explicit surface that the renderer can consume safely under context isolation.

In practice, RPC calls move from renderer to main through a predictable pipeline.
The client created in `src/renderer.ts` encodes request payloads from schema
types into transport payloads, forwards them through `invoke`, and expects an
envelope-shaped response. On the main side, `createRpcEndpoint` in `src/main.ts`
decodes the request, executes an `Effect` handler using an injected `Context`,
and encodes the result back into a response envelope. That envelope can represent a
successful domain result, a typed domain failure, or a defect. Back in the
renderer, the response is parsed and decoded into an `Effect` that succeeds
with the domain result, fails with a typed domain error, or fails with
`RpcDefectError`.

Events follow the opposite direction. Main process code publishes an event and
payload, and the publisher enqueues it into a bounded buffer. Once started, the
publisher drains the queue and sends encoded payloads through Electron channels.
Renderer subscribers decode payloads before invoking handlers so malformed data
does not silently leak into application code. The subscriber can run in a safe
mode that reports decode failures without throwing, or in a strict mode that
throws immediately so failures are impossible to ignore during development.

The architecture is deliberate about lifecycle, because Electron process and
window lifetimes are often noisy. Endpoints and publishers have explicit
`start`, `stop`, and `dispose` phases. `stop` and `dispose` are idempotent, and
`dispose` is terminal, which prevents stale transport objects from being reused
after teardown. This makes both production bootstrapping and tests predictable.

Reliability comes from a combination of validation, bounded buffering, and
non-fatal diagnostics hooks. Boundary decode/encode happens on every crossing to
catch integration errors early. Event buffering is bounded and intentionally
drop-oldest under pressure to avoid unbounded memory growth in the main process.
Diagnostics callbacks are always invoked through `safelyCall` so observability
cannot destabilize transport behavior.

Streaming RPC extends the request-response model to support long-running
operations that emit multiple values over time. The contract gains a
`streamMethods` array alongside `methods` and `events`, defined with
`streamRpc()`. On main, stream handlers return `Stream.Stream` instead of
`Effect.Effect`. On the renderer, stream callers return `Stream.Stream` that
the consumer pulls from like any other Effect stream.

The streaming protocol uses a fixed-channel design. The renderer generates a
`streamId` (UUID) and registers a frame dispatcher before calling `invoke` on a
handshake channel (`rpc/stream/{name}`). This eliminates the race condition
where frames arrive before the listener is set up. Main forks a Fiber for each
stream and sends data, end, error, or defect frames through a single shared
channel (`rpc/sf`) with the `streamId` in each payload. Cancellation goes
through `invoke` on `rpc/stream-cancel`, keeping the `IpcMainLike` type
unchanged (no `on`/`removeListener` needed).

On main, active streams are tracked in a map keyed by `streamId`. Each entry
stores the Fiber reference and the sender's `webContents.id` so that cancel
requests are authenticated. When the endpoint stops, all active Fibers are
interrupted before handlers are removed. A destroyed sender also terminates
its streams: the per-chunk send interrupts the pipeline when the webContents
is gone, and when the sender exposes the real Electron event emitter the
endpoint interrupts the fiber immediately on `destroyed`, so handler fibers
never outlive closed windows. On the renderer, Effect v4's `Stream.callback`
drives the consumer through a queue, with an `addFinalizer` that cleans up the
frame dispatcher and sends a cancel to main. The stream client has its own `dispose()` method
that fails any active streams before removing the central frame listener.

Compatibility is handled in the renderer by supporting a dual decode mode for
RPC responses. Envelope transport is the primary wire contract, but `dual` mode
can still decode legacy `Effect.Exit` payloads during migration windows. This
lets hosts move forward without requiring a flag day across all processes.
