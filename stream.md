Streaming RPC for electron-effect-rpc

The core constraint

ipcMain.handle / ipcRenderer.invoke is request → single response. You can't send multiple frames
through it. But webContents.send / ipcRenderer.on supports arbitrary message passing. The trick is
combining both: invoke for the handshake, webContents.send for frames.

This design uses fixed shared channels (not per-stream dynamic channels) with streamId in the
payload, renderer-generated streamIds to eliminate handshake race conditions, and cancel-via-invoke
to minimize the IpcMainLike type surface.

User-facing API

Contract definition — new streamRpc() function:

  export const StreamAiGeneration = streamRpc(
    "StreamAiGeneration",
    Schema.Struct({ prompt: Schema.String }),   // request
    Schema.Struct({ delta: Schema.String }),    // chunk (each frame)
    AiGenerationErrorSchema,                    // error (typed)
  )

Handler signature — returns Stream.Stream instead of Effect.Effect:

  // Current rpc: handler returns Effect<Res, Err, R>
  // Stream rpc: handler returns Stream<Chunk, Err, R>

  const streamHandlers = {
    StreamAiGeneration: (input) =>
      LanguageModel.streamText({ prompt: input.prompt }).pipe(
        Stream.map((part) => ({ delta: part.delta })),
      ),
  }

Endpoint creation — streamHandlers in options (non-breaking):

  // Existing signature is unchanged: createRpcEndpoint(contract, ipc, implementations, options)
  // streamHandlers goes into the options object:
  createRpcEndpoint(contract, ipcMain, handlers, {
    runtime,
    streamHandlers: { StreamAiGeneration: ... },
  })

  This is non-breaking: existing call sites without streamHandlers continue to work unchanged.
  The streamHandlers field is optional on RpcEndpointOptions.

Renderer client — returns Stream.Stream<Chunk, Error>:

  // Consuming in the renderer
  ipc.streamClient.StreamAiGeneration({ prompt: "hello" }).pipe(
    Stream.runForEach((chunk) =>
      Effect.sync(() => aiStore.send({ type: "appendDelta", delta: chunk.delta }))
    ),
    Effect.catchTags({
      HttpResponseError: (e) => ...,
    }),
    Effect.runPromise,
  )

Under the hood — the protocol

Fixed channels, renderer-generated streamId

All stream frames flow through a single shared channel per direction. The renderer generates
the streamId before calling invoke, so the frame dispatcher is registered before any frames can
arrive. This eliminates the handshake race condition.

  Renderer                                  Main
     │                                       │
     │  generate streamId (UUID)             │
     │  register streamId in local           │
     │    frame dispatch map                 │
     │                                       │
     │─── invoke("rpc/stream/Name",          │
     │      { data, streamId }) ────────────►│
     │                                       │  decode input
     │                                       │  validate streamId (format + uniqueness)
     │                                       │  reserve entry in activeStreams
     │                                       │  fork Fiber (via injected Runtime)
     │◄── { type: "stream_started" } ────────│  return acknowledgment
     │                                       │
     │◄── send("rpc/sf", { streamId, type: "data", payload }) ──│  Stream emits
     │◄── send("rpc/sf", { streamId, type: "data", payload }) ──│  Stream emits
     │◄── send("rpc/sf", { streamId, type: "end" }) ────────────│  Stream completes
     │                                       │
     │─── invoke("rpc/stream-cancel",        │
     │      { streamId }) ──────────────────►│  cancel
     │                                       │  verify sender matches
     │                                       │  interrupt Fiber
     │◄── { cancelled: true } ───────────────│

Why renderer-generated streamIds:

  The original design had main generate the streamId and fork the Fiber before returning the
  handshake response. This creates a race: the Fiber can emit frames before the renderer's
  .then() callback sets up the listener. Those frames are lost and the renderer hangs forever.

  With renderer-generated streamIds, the renderer registers its dispatch callback synchronously
  before calling invoke. Since invoke crosses the IPC boundary (async), the callback is guaranteed
  to exist before main can send any frames. Race-free by construction.

Why fixed channels (not per-stream dynamic channels):

  The original design used per-stream channels like sf/{streamId}. Problems:
  - Each stream registers/unregisters an ipcMain.once listener — O(n) listener churn
  - ipcMain.once for cancel is never cleaned up on natural completion — listener leak
  - The existing subscribe adapter prefixes with channelPrefix.event, so subscribe("sf/{id}")
    actually listens on "event/sf/{id}" while main sends on "sf/{id}" — streams silently hang
  - Per-stream channels bypass the channelPrefix system entirely

  Fixed channels solve all of these:
  - One ipcMain.handle for cancel, registered once at start() — no on/removeListener needed
  - Main-side activeStreams map dispatches based on streamId in the payload
  - All channels go through channelPrefix.rpc — no namespace collisions
  - Cleanup is a map.delete, not a listener removal

Why cancel-via-invoke (not fire-and-forget send):

  Using invoke for cancel eliminates the need for ipc.on/removeListener on IpcMainLike entirely.
  The cancel handler is just another ipcMain.handle registration, managed by the same
  handle/removeHandler lifecycle as everything else. This means:
  - IpcMainLike stays at { handle, removeHandler } — no new optional members
  - Existing test mocks work unchanged — no on/removeListener stubs needed
  - No separate cancel listener lifecycle to manage in start()/stop()
  - The bridge needs only invoke (already exists) — no new cancelStream adapter

  The cost is a trivial response payload ({ cancelled: true/false }), which the renderer ignores
  (cancel is fire-and-forget from the renderer's perspective — Effect.tryPromise(...).pipe(Effect.ignore)).

Channel naming:

  Handshake:     ${channelPrefix.rpc}stream/${method.name}   (invoke/handle)
  Frames:        ${channelPrefix.rpc}sf                       (webContents.send / ipcRenderer.on)
  Cancel:        ${channelPrefix.rpc}stream-cancel             (invoke/handle)

  Reserved name validation: defineContract validates that no method or stream method name begins
  with "stream/" or equals "sf" or "stream-cancel", preventing collision with internal channels.

Stream frame envelope

All frames on the sf channel carry a discriminated payload:

  type StreamFrame =
    | { type: "data";   streamId: string; payload: unknown }
    | { type: "end";    streamId: string }
    | { type: "error";  streamId: string; error: { tag: string; data: unknown } }
    | { type: "defect"; streamId: string; message: string }

This gets a parseStreamFrame() validator in protocol.ts, mirroring the existing
parseRpcResponseEnvelope pattern (defensive parsing, never trust raw IPC payloads).

What needs to change in each module

contract.ts

Add StreamRpcMethod and streamRpc():

  interface StreamRpcMethod<
    Name extends string,
    Req extends SchemaNoContext,
    Chunk extends SchemaNoContext,
    Err extends ErrorSchema = NoError
  > {
    readonly name: Name
    readonly req: Req
    readonly chunk: Chunk
    readonly err: Err
    readonly _tag: "StreamRpcMethod"   // discriminant (idiomatic Effect style)
  }

  function streamRpc(name, req, chunk, err?): StreamRpcMethod

Extend RpcContract with an optional streamMethods array:

  interface RpcContract<Methods, Events, StreamMethods = readonly []> {
    readonly methods: Methods
    readonly events: Events
    readonly streamMethods: StreamMethods
  }

defineContract gains:
  - An optional streamMethods field (defaults to [])
  - Cross-array name collision validation: no name may appear in both methods and streamMethods
  - Reserved name validation: reject names starting with "stream/" or matching reserved channel
    suffixes ("sf", "stream-cancel") to prevent collision with internal transport channels
  - Uses the existing collectDuplicates utility, extended to check the union of both name arrays

types.ts

New duck type for the sender (used only in stream handler internals, not on IpcMainLike):

  type WebContentsLike = {
    readonly id: number
    readonly isDestroyed: () => boolean
    readonly send: (channel: string, payload: unknown) => void
  }

IpcMainLike stays unchanged:

  The handle callback's event parameter stays typed as unknown. Stream handlers cast it
  internally with runtime validation (check that event has a sender property with the expected
  shape). This avoids breaking every existing test mock that passes {} as the event.

  IpcMainLike does NOT gain on/removeListener — cancel-via-invoke means we only need
  handle/removeHandler, which already exist.

  type IpcMainLike = {
    readonly handle: (
      channel: string,
      listener: (event: unknown, payload: unknown) => unknown
    ) => unknown
    readonly removeHandler: (channel: string) => unknown
  }
  // Unchanged from current.

New types for stream implementations and client:

  type StreamImplementations<C, R = never> = {
    readonly [Name in C["streamMethods"][number]["name"]]: (
      input: StreamInput<C, Name>
    ) => Stream.Stream<StreamChunk<C, Name>, StreamError<C, Name>, R>
  }

  type StreamRpcCaller<M> =
    IsEmptyObject<StreamInput<M>> extends true
      ? () => Stream.Stream<StreamChunk<M>, StreamMethodError<M>>
      : (input: StreamInput<M>) => Stream.Stream<StreamChunk<M>, StreamMethodError<M>>

  type StreamRpcClient<C> = {
    readonly [Name in C["streamMethods"][number]["name"]]: StreamRpcCaller<...>
  }

Extend DecodeFailureScope for stream diagnostics:

  type DecodeFailureScope =
    | "rpc-request"
    | "rpc-response"
    | "event-payload"
    | "stream-request"      // stream handshake input decode
    | "stream-chunk"        // stream data frame chunk decode
    | "stream-error"        // stream error frame decode

New defect codes for streaming (kept minimal — use existing codes where semantics overlap):

  type RpcDefectCode =
    | ... existing codes ...
    | "stream_invoke_failed"          // invoke for handshake failed
    | "stream_handshake_invalid"      // handshake response unrecognized
    | "stream_chunk_decode_failed"    // data frame payload decode failed
    | "stream_error_decode_failed"    // error frame decode failed

protocol.ts

Add StreamFrame type and parseStreamFrame() validator:

  function parseStreamFrame(value: unknown): StreamFrame | null

Same defensive pattern as parseRpcResponseEnvelope: check isRecord, validate type field,
validate streamId is string, validate sub-fields per frame type. Returns null for anything
malformed.

Add toStreamDefectFrame(streamId, cause, prefix?):

  function toStreamDefectFrame(streamId: string, cause: unknown, prefix?: string): StreamFrame

main.ts

createRpcEndpoint gains streaming support via the options object. The existing function signature
and behavior are unchanged when streamHandlers is not provided.

Active stream tracking:

  const activeStreams = new Map<string, {
    fiber: Fiber.RuntimeFiber<void, unknown>
    senderId: number
  }>()

The map is keyed by streamId. It stores the Fiber reference and the sender's webContents.id
for cancel authentication.

Cancel handler — a standard ipcMain.handle registration:

  ipc.handle(`${channelPrefix.rpc}stream-cancel`, (event, rawPayload) => {
    const streamId = typeof rawPayload === "object" && rawPayload?.streamId
    if (typeof streamId !== "string") return { cancelled: false }
    const entry = activeStreams.get(streamId)
    if (!entry) return { cancelled: false }

    // Validate sender identity
    const sender = extractSender(event)  // runtime cast + validation
    if (!sender || sender.id !== entry.senderId) return { cancelled: false }

    // Imperative interrupt — Fiber.interrupt returns an Effect, so we use the
    // RuntimeFiber's unsafeInterruptAsFork method for synchronous fire-and-forget.
    entry.fiber.unsafeInterruptAsFork(FiberId.none)
    return { cancelled: true }
  })

  extractSender(event) is a runtime helper that checks event?.sender?.id exists and returns
  a typed WebContentsLike or null. This keeps IpcMainLike's event type as unknown while
  accessing sender safely in stream-specific code paths.

Per-stream-method handler registration:

  ipc.handle(`${channelPrefix.rpc}stream/${method.name}`, async (event, rawPayload) => {
    // 1. Decode the incoming envelope { data, streamId }
    const { data, streamId } = rawPayload
    const input = decodeInput(data)

    // 2. Extract and validate sender
    const sender = extractSender(event)
    if (!sender) return toDefectEnvelope("stream handler requires sender")

    // 3. Validate streamId (must be string, must not already exist)
    if (typeof streamId !== "string" || activeStreams.has(streamId)) {
      return toDefectEnvelope("invalid or duplicate streamId")
    }

    // 4. Sender guard helper — interrupts the stream when sender is destroyed
    const safeSend = (frame: StreamFrame): void => {
      if (sender.isDestroyed()) throw new SenderDestroyed()
      sender.send(`${channelPrefix.rpc}sf`, frame)
    }

    // 5. Build the stream effect
    const runFork = Runtime.runFork(options.runtime)

    const streamEffect = handler(input).pipe(
      Stream.mapEffect((chunk) =>
        Effect.sync(() => {
          safeSend({ type: "data", streamId, payload: encodeChunk(chunk) })
        })
      ),
      Stream.runDrain,

      // On success: send end frame
      Effect.andThen(() =>
        Effect.sync(() => safeSend({ type: "end", streamId }))
      ),

      // Catch all cause variants (Fail, Die, Interrupt)
      Effect.catchAllCause((cause) =>
        Effect.sync(() => {
          const failure = Cause.failureOption(cause)
          if (failure._tag === "Some") {
            // Typed failure — encode and send error frame
            // Guard encodeFailure: if encoding throws, fall through to defect frame
            try {
              safeSend({
                type: "error", streamId,
                error: {
                  tag: extractErrorTag(failure.value),
                  data: encodeFailure(failure.value),
                },
              })
            } catch {
              safeSend({ type: "defect", streamId, message: formatUnknown(failure.value) })
            }
          } else if (Cause.isInterruptedOnly(cause)) {
            // Interruption (from cancel or stop) — send end frame, not an error
            try { safeSend({ type: "end", streamId }) } catch { /* sender destroyed */ }
          } else {
            const defect = Cause.dieOption(cause)
            const message = defect._tag === "Some"
              ? formatUnknown(defect.value)
              : "Stream failed unexpectedly"
            try { safeSend({ type: "defect", streamId, message }) } catch { /* sender destroyed */ }
          }
        })
      ),

      // Always clean up: remove from activeStreams
      Effect.ensuring(Effect.sync(() => {
        activeStreams.delete(streamId)
      })),
    )

    // 6. Reserve entry BEFORE forking (prevents ordering race with synchronous streams)
    //    Runtime.runFork starts the fiber immediately. If the stream completes synchronously,
    //    Effect.ensuring calls activeStreams.delete before we'd normally call .set.
    //    By setting first with a placeholder, ensuring always finds the entry.
    const entry: { fiber: Fiber.RuntimeFiber<void, unknown> | null; senderId: number } = {
      fiber: null,
      senderId: sender.id,
    }
    activeStreams.set(streamId, entry as any)

    const fiber = runFork(streamEffect)
    entry.fiber = fiber

    return { type: "stream_started" }
  })

Key properties of this handler:

  safeSend throws SenderDestroyed (not returns boolean):
    When the sender is destroyed, safeSend throws. Inside Effect.sync, this becomes a Die cause.
    The catchAllCause handler catches it, tries to send a terminal frame (which also throws
    since sender is destroyed), catches that silently, and the ensuring block cleans up. The
    stream Fiber terminates — it does NOT continue pulling chunks from the handler.

    This is simpler and more correct than returning a boolean: the stream pipeline naturally
    terminates via Effect's error propagation instead of requiring manual boolean checks at
    every call site.

  encodeFailure is defensively guarded:
    If encodeFailure throws (e.g., the error shape doesn't match the schema), the catch block
    falls through to a defect frame with the raw error message. This mirrors the existing RPC
    endpoint pattern (main.ts:155-165) where encoding failures are caught and reported.

  activeStreams.set before runFork:
    The map entry is reserved before the Fiber is forked. This prevents the ordering race where
    a synchronous stream completes (and ensuring deletes) before the entry is inserted.

  Interrupt sends "end" not "error":
    An interrupted stream is a normal lifecycle event (cancel, stop). The renderer receives
    an "end" frame and the stream completes cleanly. Only handler failures produce error/defect
    frames.

  Uses injected Runtime:
    Runtime.runFork(options.runtime) — per ADR-0002. Stream handlers have access to the same
    Effect services as regular RPC handlers.

Lifecycle integration:

  stop() must:
    1. Remove all stream method handlers (ipc.removeHandler for each stream/ channel)
    2. Remove the cancel handler (ipc.removeHandler for stream-cancel channel)
    3. Interrupt all active Fibers imperatively:
       for (const entry of activeStreams.values()) {
         if (entry.fiber) entry.fiber.unsafeInterruptAsFork(FiberId.none)
       }
       activeStreams.clear()

    Fiber.interrupt(fiber) returns an Effect<Exit> — calling it as a bare expression is a no-op.
    For synchronous stop(), use the RuntimeFiber's unsafeInterruptAsFork method which sends
    the interrupt signal without awaiting completion.

    Ordering: interrupt fibers first (so ensuring cleanup runs), then remove handlers. This
    prevents new streams from starting while existing ones drain.

  dispose() calls stop() then marks as disposed (same pattern as existing endpoint).

  This integrates cleanly with the existing lifecycle model (ADR-0005): stop() is reversible
  (can start() again), dispose() is terminal.

renderer.ts

New createStreamRpcClient function. Separate from createRpcClient because the return types
and construction patterns are fundamentally different (Stream vs Effect).

The stream client has its own dispose() for lifecycle compliance (ADR-0005).

Central frame dispatch:

  The client maintains a shared frame dispatcher:

  const frameDispatcher = new Map<string, {
    data: (payload: unknown) => void
    end: () => void
    error: (error: { tag: string; data: unknown }) => void
    defect: (message: string) => void
  }>()

  A central frame listener (set up once via onStreamFrame) parses each incoming frame and
  dispatches to the registered handler:

  const centralCleanup = bridge.onStreamFrame((raw) => {
    const frame = parseStreamFrame(raw)
    if (!frame) {
      safelyCall(diagnostics?.onProtocolError, { method: "stream-frame", response: raw, cause: null })
      return
    }
    const handler = frameDispatcher.get(frame.streamId)
    if (!handler) return  // stale frame for a completed/cancelled stream
    switch (frame.type) {
      case "data":   handler.data(frame.payload); break
      case "end":    handler.end(); frameDispatcher.delete(frame.streamId); break
      case "error":  handler.error(frame.error); frameDispatcher.delete(frame.streamId); break
      case "defect": handler.defect(frame.message); frameDispatcher.delete(frame.streamId); break
    }
  })

  // Both the central listener's immediate delete (on terminal frames) and the addFinalizer's
  // delete serve different purposes:
  // - Central listener deletes immediately to prevent stale frame dispatch between emit.end()
  //   and scope closure
  // - addFinalizer deletes to handle consumer-side interruption (Stream.take, cancel) where
  //   no terminal frame was received

  dispose() cleans up the central listener:
    function dispose() {
      centralCleanup()
      frameDispatcher.clear()
    }

Per-method stream caller using Stream.asyncPush:

  Stream.asyncPush is the right primitive. It provides:
  - Scoped lifecycle: the register callback returns Effect<unknown, E, R | Scope>, so we can use
    Effect.addFinalizer for deterministic cleanup on all exit paths (success, failure, interrupt)
  - Push-based emit: emit.single(value), emit.end(), emit.fail(error) — maps directly to our
    frame dispatch callbacks
  - Configurable buffering: default is unbounded for asyncPush per the Effect docs

  const streamCaller = (input) =>
    Stream.asyncPush<Chunk, StreamMethodError>((emit) =>
      Effect.gen(function*() {
        const streamId = crypto.randomUUID()

        // 1. Register in dispatch map BEFORE calling invoke (race-free guarantee)
        frameDispatcher.set(streamId, {
          data: (payload) => {
            let decoded
            try { decoded = decodeChunk(payload) }
            catch (cause) {
              safelyCall(diagnostics?.onDecodeFailure, {
                scope: "stream-chunk", name: method.name, payload, cause,
              })
              emit.fail(rpcDefect("stream_chunk_decode_failed", ..., cause))
              return
            }
            emit.single(decoded)
          },
          end: () => emit.end(),
          error: (err) => {
            let decoded
            try { decoded = decodeTypedError(method, err) }
            catch (cause) {
              safelyCall(diagnostics?.onDecodeFailure, {
                scope: "stream-error", name: method.name, payload: err, cause,
              })
              emit.fail(rpcDefect("stream_error_decode_failed", ..., cause))
              return
            }
            emit.fail(decoded)
          },
          defect: (message) => emit.fail(rpcDefect("remote_defect", message, undefined)),
        })

        // 2. Register cleanup finalizer (runs on complete, fail, or interrupt)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            frameDispatcher.delete(streamId)
            // Send cancel to main — fire-and-forget via invoke, ignore response/errors
            bridge.invoke("stream-cancel", { streamId }).catch(() => {})
          })
        )

        // 3. Initiate the stream on main
        const response = yield* Effect.tryPromise({
          try: () => bridge.invoke(
            `stream/${method.name}`,
            { data: encodeInput(input), streamId }
          ),
          catch: (cause) => rpcDefect("stream_invoke_failed",
            `Stream ${method.name} invoke failed: ${formatUnknown(cause)}`, cause),
        })

        // 4. Validate handshake response — check for defect envelope first to preserve
        //    structured error messages from main (e.g., input decode failures)
        const envelope = parseRpcResponseEnvelope(response)
        if (envelope?.type === "defect") {
          return yield* Effect.fail(
            rpcDefect("remote_defect", envelope.message, envelope.cause)
          )
        }
        if (!isStreamStartedResponse(response)) {
          return yield* Effect.fail(
            rpcDefect("stream_handshake_invalid",
              `Stream ${method.name} unexpected handshake response`, response)
          )
        }
      }),
      { bufferSize: 16, strategy: "dropping" },
    )

  Buffering strategy:
    Stream.asyncPush defaults to unbounded. We override with { bufferSize: 16, strategy: "dropping" }
    to align with ADR-0006's bounded-queue principle. For AI token streaming, 16 is generous
    (the renderer pulls faster than tokens arrive). The dropping strategy discards the newest
    frame under pressure, which is acceptable since the end frame always terminates the stream
    regardless of prior drops. Users can override via a future options parameter if needed.

  Cancel in the finalizer:
    The finalizer sends cancel via invoke (fire-and-forget: .catch(() => {})). After natural
    completion, main's cancel handler returns { cancelled: false } because the entry was already
    deleted by ensuring. This is harmless. After consumer interruption (e.g., Stream.take(5)),
    the cancel actually interrupts the main Fiber.

  Handshake error parsing:
    The handshake response is first checked against parseRpcResponseEnvelope. If main returned
    a defect envelope (e.g., input decode failure), the renderer preserves the structured error
    message instead of collapsing it into a generic "stream_handshake_invalid".

preload.ts

The bridge gains one new adapter for receiving stream frames:

  interface IpcBridge {
    invoke: (method: string, payload: unknown) => Promise<unknown>
    subscribe: (name: string, listener: (payload: unknown) => void) => () => void
    // Streaming (optional — present when streaming is configured)
    onStreamFrame?: (listener: (frame: unknown) => void) => () => void
  }

  Cancel uses the existing invoke adapter — no new bridge methods needed for cancel.

createBridgeAdapters gains:

  const onStreamFrame = (listener: (frame: unknown) => void) => {
    const channel = `${channelPrefix.rpc}sf`
    const wrapped = (_event: IpcRendererEvent, frame: unknown) => listener(frame)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
  }

  Security: onStreamFrame is read-only (subscribes, doesn't send) — same security posture
  as the existing subscribe adapter. Cancel goes through invoke, which already constrains
  channels via channelPrefix.

  Stream client construction validates that bridge.onStreamFrame is present when the contract
  has stream methods. Fails fast with a clear error, not silently degraded.

kit.ts

RpcEndpointOptions gains (non-breaking — field is optional):

  readonly streamHandlers?: StreamImplementations<C, R>

IpcKit.renderer returns (additive — new field alongside existing ones):

  {
    client: RpcClient<C>,
    events: EventSubscriber<C>,
    streamClient: StreamRpcClient<C>,   // new — has its own dispose()
  }

The kit's stop()/dispose() coordinates stream lifecycle:
  - stop() calls endpoint.stop() (which now interrupts stream fibers) then publisher.stop()
  - dispose() calls streamClient.dispose() on the renderer side

Resolved design decisions

1. Separate handler maps (decided: yes)

  handlers and streamHandlers are separate. This keeps the type system simple:
  Implementations maps method names to Effect-returning functions, StreamImplementations maps
  stream method names to Stream-returning functions. No union types, no conditional mapped types,
  clean inference.

2. IpcMainLike stays unchanged (decided)

  The handle callback's event parameter stays typed as unknown. Stream handler code casts
  internally with runtime validation (extractSender helper). This avoids breaking any existing
  test mock that passes {} as the event.

  IpcMainLike does NOT gain on/removeListener. Cancel-via-invoke means the cancel handler
  is just another ipcMain.handle registration, managed by handle/removeHandler.

3. Stream.asyncPush (decided)

  Stream.asyncPush is the correct primitive for the renderer-side stream construction:
  - Its register callback returns Effect<unknown, E, R | Scope>, providing a natural Scope
    for cleanup via Effect.addFinalizer
  - Its emit API (emit.single, emit.end, emit.fail) maps directly to frame dispatch callbacks
  - Effect.addFinalizer guarantees cleanup on all exit paths (success, failure, interruption)

  Stream.async was rejected: its cleanup function only runs when the consumer cancels, and it
  requires mixing Promise callbacks with Effect cleanup. Stream.unwrap was rejected: it requires
  constructing the inner Stream before returning, which is awkward when the data source is a
  push-based IPC listener.

4. Renderer-generated streamId (decided)

  The renderer generates the streamId (crypto.randomUUID()) and registers the frame dispatcher
  before calling invoke. This eliminates the race condition by construction: the listener
  exists before any frames can arrive. Main validates the streamId format and rejects duplicates.

5. Fixed channels with streamId in payload (decided)

  One channel for all frames (rpc/sf), one invoke channel for cancel (rpc/stream-cancel).
  The streamId is part of the payload. Benefits:
  - No per-stream listener registration/cleanup on either side
  - All channels go through the channelPrefix system — no namespace collisions
  - Cleanup is a map.delete, not a listener removal

6. Cancel via invoke (decided)

  Cancel goes through ipcMain.handle / ipcRenderer.invoke, not ipcMain.on / ipcRenderer.send.
  This eliminates:
  - on/removeListener on IpcMainLike — type stays unchanged
  - cancelStream adapter on the bridge — invoke already exists
  - Separate listener lifecycle management in start()/stop()
  - Construction-time validation that on/removeListener are present

  Cancel authentication: the cancel handler extracts event.sender from the invoke event and
  validates sender.id matches the stored stream's senderId.

7. safeSend throws on destroyed sender (decided)

  safeSend throws SenderDestroyed instead of returning a boolean. Inside Effect.sync, this
  becomes a Die cause. catchAllCause catches it and the stream terminates. This is simpler
  and more correct than boolean checks: the Effect error propagation naturally stops the stream
  pipeline. No risk of silently continuing to process chunks for a dead window.

8. Effect.catchAllCause for stream errors (decided)

  The main-side stream effect uses Effect.catchAllCause (not Effect.catchAll). This catches
  all Cause variants:
  - Fail → typed error frame (tag + data, schema-encoded; encoding guarded with try/catch)
  - Die (SenderDestroyed) → stream terminates silently, cleanup via ensuring
  - Die (other) → defect frame (message string)
  - Interrupt → end frame (interruption is a normal lifecycle event)

9. activeStreams.set before runFork (decided)

  The map entry is reserved before the Fiber is forked. Runtime.runFork starts the fiber
  immediately — a synchronous stream can complete (and ensuring can call activeStreams.delete)
  before a subsequent .set. By reserving first, ensuring always finds the entry.

10. Backpressure (decided: bounded buffer with dropping strategy)

  Stream.asyncPush is configured with { bufferSize: 16, strategy: "dropping" }. This aligns
  with ADR-0006's bounded-queue principle. For AI token streaming, 16 is generous. The dropping
  strategy under pressure is acceptable because the end frame always terminates cleanly. Users
  can override via a future options parameter if needed.

Edge cases and safety

Sender destruction mid-stream:

  safeSend throws SenderDestroyed. Inside Stream.mapEffect's Effect.sync, this becomes a Die.
  catchAllCause catches it. The handler tries to send a terminal frame (which also throws
  since the sender is destroyed), the inner try/catch swallows that, and ensuring cleans up
  the activeStreams entry. The stream Fiber terminates — it does NOT continue processing chunks.

Concurrent streams:

  Multiple streams can run simultaneously. Each has its own entry in activeStreams, its own
  Fiber, and its own streamId in the frame dispatcher. No shared mutable state between streams
  beyond the maps themselves.

Cancel after natural completion:

  If the renderer's Scope finalizer invokes cancel after the stream has already completed on
  main, the cancel handler checks activeStreams — the entry was already deleted by
  Effect.ensuring. It returns { cancelled: false }. Harmless.

Endpoint stop/dispose during active streams:

  stop() interrupts all active Fibers via unsafeInterruptAsFork (imperative, synchronous),
  then clears activeStreams, then removes all handle registrations. Each interrupted Fiber's
  catchAllCause sends an end frame (if sender is alive), and ensuring removes the map entry.

  Ordering: interrupt first → remove handlers second. This prevents new streams from starting
  while existing ones drain their terminal frames.

Runtime injection:

  Stream Fibers are forked using Runtime.runFork(options.runtime), the same injected Runtime
  used for regular RPC handlers. This ensures stream handlers have access to the same Effect
  services (Context tags, Layers) as the rest of the application, per ADR-0002.

Diagnostics:

  Stream frame decode failures on the renderer go through the existing onDecodeFailure diagnostic
  hook with new scopes: "stream-chunk" for data frame decode failures, "stream-error" for error
  frame decode failures. Stream protocol errors (malformed frames) go through onProtocolError.
  This mirrors the existing diagnostics pattern (ADR-0007).

  parseStreamFrame provides the same defensive boundary as parseRpcResponseEnvelope — malformed
  frames trigger diagnostics but never crash transport internals.

Testing considerations:

  IpcMainLike is unchanged, so existing test stubs (rpc-server.test.ts, integration.test.ts,
  kit.test.ts) work without modification. New stream tests need:

  - A mock sender object: { id: 1, isDestroyed: () => false, send: vi.fn() }
  - The handle callback receives { sender: mockSender } as the event, which extractSender
    validates at runtime
  - Frame assertion: inspect mockSender.send calls to verify frame payloads
  - Cancel testing: call the stream-cancel handler directly (it's just another handle)
  - Destroyed sender testing: set isDestroyed to return true, verify the Fiber terminates
  - The existing createInvokeStub and createRpcHarness patterns extend naturally

Summary

The streaming extension adds streamRpc() contracts, Stream.Stream return types in handlers and
client, and a fixed-channel frame protocol with renderer-generated streamIds. The protocol is
race-free by construction, integrates with the existing lifecycle (start/stop/dispose), and
respects the channelPrefix namespace system.

Non-breaking: the createRpcEndpoint signature is unchanged (streamHandlers goes into options).
IpcMainLike type is unchanged (cancel uses handle, event stays unknown). Existing tests work
without modification.

Key implementation areas:
  - protocol.ts: StreamFrame type + parseStreamFrame validator
  - contract.ts: StreamRpcMethod, streamRpc(), extended defineContract with reserved name checks
  - types.ts: WebContentsLike, StreamImplementations, StreamRpcClient, extended DecodeFailureScope
  - main.ts: activeStreams map, extractSender helper, stream handlers with safeSend/SenderDestroyed
  - renderer.ts: createStreamRpcClient with frame dispatcher, Stream.asyncPush, and dispose()
  - preload.ts: onStreamFrame bridge adapter
  - kit.ts: wire streamHandlers through options, add streamClient to renderer return
