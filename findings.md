# Package Review: electron-effect-rpc v0.8.0

Reviewed: 2026-06-09. Scope: all of `src/` (~2,800 lines), package.json, README, docs/, tutorials, ADRs, test suite (183 tests, all passing).

> **Status (2026-06-09): all findings addressed.** C1 (fiber leak), C2 (migrated to `effect/Schema`, peer floor `>=3.10.0`), C3 (`context` removed), C6 (AST-based NoError check), C7 (prefix validation), C9 (all nits), and ergonomics gaps 1/2/3/5/6/7/8 are fixed in source with regression tests (193 tests passing). C4/C5/C8 are documented in README "Operational Notes" / "Error Model" as recommended (real backpressure remains a protocol-level future change). See `CHANGELOG.md` (Unreleased) for the breaking-change list. The sections below are the original review, kept for reference.

**Overall verdict:** This is a well-designed, carefully implemented library. The contract-first model, envelope protocol, lifecycle discipline, and diagnostics-never-throw policy are all sound and consistently applied. The ADRs match the code. Test coverage is strong for the paths it covers. The findings below are ordered by severity; the first two are the ones I'd fix before promoting this beyond 0.x.

---

## Correctness

### C1 (High): Main-side stream fibers leak when the renderer goes away without cancelling

`src/main.ts:338-354` — when the sender's webContents is destroyed mid-stream, `trySend` and the per-chunk `mapEffect` silently skip the send (`if (sender.isDestroyed()) return;`) but **nothing interrupts the stream fiber**. The source stream keeps draining to completion.

- For finite streams this is wasted work (the existing test at `__tests__/stream.test.ts:986` only covers a finite 50-item stream, so it passes).
- For infinite streams (subscriptions, watchers, token generators that block on a pull) the fiber runs **forever**. The renderer-side cancel finalizer never fires on a hard window close, crash, or page reload — the page is destroyed, Effect finalizers in the renderer never run, and main never receives `rpc/stream-cancel`.

The memory/ADR notes mention a "SenderDestroyed error / safeSend throws" pattern; the current code does not implement it — sends are `Effect.ignore`d instead of failing the stream.

**Fix options:** (a) make the per-chunk send _fail_ (not skip) when `sender.isDestroyed()`, so the pipeline terminates; (b) additionally, since a stream can be idle between chunks indefinitely, register a `destroyed` listener on the sender (would require widening `WebContentsLike` with `once`/`on`, or accept the chunk-granularity check as the documented guarantee) and interrupt all of that sender's fibers; (c) at minimum, interrupt active streams for a sender when a new handshake from a fresh page arrives. Add a regression test with `Stream.never`/`Stream.repeatEffect` + destroyed sender asserting the fiber terminates.

### C2 (High): Peer dependency ranges are wrong, and `@effect/schema` is deprecated

- `package.json` declares `"effect": ">=3.0.0"`, but `src/renderer.ts` uses `Stream.asyncPush`, which was added in **effect 3.6.0** (verified: absent from 3.5.9's `Stream.d.ts`, present in 3.6.0). A consumer on effect 3.0–3.5 installs cleanly and crashes at runtime on the first stream call.
- `"@effect/schema": ">=0.69.0"` — @effect/schema 0.69.x itself peer-requires `effect ^3.5.9`, contradicting the `>=3.0.0` floor.
- Bigger picture: **@effect/schema was merged into effect core at 3.10** (`effect/Schema`) and the standalone package is deprecated. Building the public contract API on the deprecated package forces every modern Effect consumer to install a legacy schema package alongside `effect/Schema`, and schemas built with `effect/Schema` are not interchangeable with the `S.Schema.AnyNoContext` types this library expects. This is the single biggest adoption blocker for new Effect 3.10+ projects.

**Fix:** raise the effect floor to `>=3.6.0` (or migrate); plan a migration to `effect/Schema` (drop the @effect/schema peer entirely, floor effect at >=3.10).

### C3 (Medium): `event()`'s `context` parameter is dead API

`src/contract.ts:58-75` accepts a third `context` schema and carries it through `RpcEvent`, but **nothing in `src/` ever reads `.context`** — the publisher encodes only `event.payload` (`src/main.ts:580`), the subscriber decodes only `event.payload`. A user who defines `event("X", PayloadSchema, ContextSchema)` gets fully typed, fully validated... nothing. Remove it or implement it; as-is it's a silent trap.

### C4 (Medium): No stream backpressure across the IPC boundary

Main pushes frames via `sender.send` as fast as the source produces; the renderer buffers. The default (and effectively only safe) buffer is unbounded — the doc comment on `StreamBufferOptions` (`src/types.ts:296-308`) itself admits bounded buffers can lose **terminal signals** under pressure with current `Stream.asyncPush` internals, meaning a bounded-buffer stream can hang forever (consumer waits for an `end` that was dropped). So in practice:

- A fast producer + slow renderer consumer = unbounded renderer memory growth.
- The bounded option is a documented footgun rather than a real alternative.

Worth at least a prominent README warning; a real fix needs an ack/credit-based protocol (frame batching + renderer pull), which is a protocol change.

### C5 (Low/Medium): Unary RPC cancellation doesn't propagate

Interrupting the renderer-side Effect of `client.SomeMethod()` does not abort the main-side handler — `Effect.tryPromise` wraps a non-abortable `ipcRenderer.invoke`. Streams got cancellation; unary calls didn't. Fine as a design choice, but it should be documented (a user timing out a slow query with `Effect.timeout` will assume the main-side work stopped).

### C6 (Low): `isNoErrorSchema` relies on reference identity with `S.Never`

`src/contract.ts:10-12` (`schema === NoError`). If npm dedup ever yields two `@effect/schema` instances (very plausible given the peer-range issues in C2), a user's `S.Never` won't be identity-equal to the library's. Result: `encodeFailure = S.encodeSync(S.Never)` which throws on every typed failure, silently converting all domain failures into defects. Consider checking the AST tag (`schema.ast._tag === "NeverKeyword"`) instead.

### C7 (Low): Channel-prefix collisions are unvalidated

- Nothing prevents `channelPrefix: { rpc: "x/", event: "x/" }` (or both `""`), in which case an event named like a method, or an event named `sf`, collides with RPC/stream-frame channels. One equality check in `createIpcKit`/`resolveChannelPrefix` would close this.
- Reserved-name validation (`sf`, `stream-cancel`, `stream/` prefix) runs for methods and streamMethods but **not events** — consistent with distinct prefixes, but it makes the prefix-equality gap above sharper.

### C8 (Low, security note): Defect envelopes leak main-process error messages to the renderer

`toDefectEnvelope` ships `error.message` (and stringified cause) verbatim across IPC. For apps that ever load remote or less-trusted content in a window sharing the bridge, main-side exception text (paths, SQL fragments, etc.) is disclosed. Worth a one-line note in the error-model docs and/or an optional redaction hook.

### C9 (Nits)

- Every normally-completed stream still fires a `stream-cancel` invoke from the renderer finalizer (`src/renderer.ts:561-571`) — one wasted IPC round-trip per stream. Cheap fix: track "terminated" in the frame handler and skip.
- Stream failure-encoding fallback (`src/main.ts:324`) emits `formatUnknown(failure.value)` which is `"[object Object]"` for plain tagged errors — the unary path uses the _encoding error_ for its message; the stream path should too.
- `src/main.ts:364-371`: if `runFork` throws synchronously (e.g. disposed runtime), the reserved `activeStreams` entry leaks.
- Kit `main()` silently ignores `streamHandlers` (including handlers for nonexistent methods) when the contract has no `streamMethods` — validation only runs when `streamMethods.length > 0` (`src/main.ts:215-226`).
- `EventPublisher.publish` succeeds silently after `dispose()`; intentional, but undocumented.
- `dropped` stat conflates per-window delivery failures with whole-event drops (an event delivered to 2 of 3 windows increments `dropped`), making the stat hard to interpret for multi-window apps.

---

## Ergonomics & ease of use

### Good

- **The kit is the right call.** One shared config object eliminating prefix drift across three processes is exactly the failure mode Electron IPC libraries usually have. `ipc.main()/preload()/renderer()` reads well and the quickstart is genuinely short.
- Zero-arg callers for `S.Struct({})` inputs (`RpcCaller`'s `IsEmptyObject`) is a nice touch.
- Renderer-generated streamId + register-dispatcher-before-invoke elegantly kills the handshake race; cancel-over-invoke keeping `IpcMainLike` two-method is a genuinely clean design.
- Stable `RpcDefectError.code` discriminators, diagnostics hooks that can never crash transport, and idempotent start/stop/dispose are all production-grade decisions, well-documented in ADRs.
- Construction-time validation (duplicate names, unknown/missing implementations, reserved names) fails fast with clear messages.

### Gaps

1. **Kit users can't attach renderer-side diagnostics.** `ipc.renderer(bridge)` passes no `diagnostics` to `createRpcClient`, `createEventSubscriber`, or `createStreamRpcClient` (`src/kit.ts:288-325`), while `ipc.main()` accepts them. Decode failures in the renderer (the most common integration error) are invisible in kit mode unless you drop to the low-level APIs. Add `ipc.renderer(bridge, { diagnostics })`.
2. **Handlers can't see the caller.** Unary implementations receive only the decoded input — no access to `event.sender`/webContents id. Multi-window apps routinely need "which window asked?" The stream path already extracts the sender internally; exposing an optional second arg (or a context service in `R`) would help.
3. **No Effect-native event consumption.** `events.subscribe(event, cb)` returns an unsubscribe function; an Effect-first library begs for `events.stream(WorkUnitProgress): Stream<Payload>` (scoped, auto-unsubscribed). Same for a `Scope`-based alternative to manual `dispose()`.
4. **`strict` event decode mode throws inside the `ipcRenderer.on` callback** — there is no caller to catch it; it becomes an uncaught exception in the renderer. That's arguably the point ("impossible to ignore during development"), but the tutorial should say "this crashes your renderer" explicitly.
5. **README's window-typing section hand-rolls the interface** (README §5) instead of using the exported `IpcBridgeGlobal` type, which exists for exactly this. Also `window.api` is typed with `onStreamFrame?` optional — kit `renderer()` throws at runtime if it's missing with stream contracts; using `IpcBridge` keeps that in sync.
6. **Custom bridges must replicate the prefixing convention.** `IpcBridge.invoke` receives the _unprefixed_ method name and the kit assumes the bridge prepends `channelPrefix.rpc`; anyone hand-writing a preload bridge (the type invites it) and forgetting the prefix gets `invoke_failed` with no hint. Document the contract on the `IpcBridge` type, or pass already-prefixed channels to the bridge so it stays dumb.
7. **Package metadata:** missing `"sideEffects": false` (tree-shaking), missing `"engines"`, `repository.url` lacks the `git+` prefix. The README quickstart's `getWindows: () => [mainWindow]` references an undefined `mainWindow` in the snippet.
8. `S.Object`-typed inputs (`keyof object = never`) get classified as "empty" by `IsEmptyObject` and produce a zero-arg caller that always sends `{}` — obscure, but a wrong-by-construction client. Constrain the check to exact `{}`.

---

## Docs & tests

- **Docs are unusually good for a 0.x package**: accurate architecture overview, 9 ADRs that match the implementation, 4 tutorials. The README "Breaking Changes" section reads oddly placed for new users (it documents a pre-0.x migration); move it to a CHANGELOG.
- **Tests (183, all passing)** cover the protocol, lifecycle, decode failure paths, stream cancel/auth/dispose, stress. Gaps worth adding:
  - infinite stream + destroyed sender (would catch C1),
  - renderer reload mid-stream (no cancel ever arrives),
  - equal rpc/event channel prefixes,
  - bounded `streamBuffer` terminal-signal loss (currently only a comment, not a pinned behavior).

## Suggested priority

1. Fix C1 (stream fiber leak) — correctness bug with unbounded resource impact.
2. Fix C2 peer floors now (`effect >=3.6.0`); plan the `effect/Schema` migration — adoption blocker.
3. Remove or implement `event()` context (C3) before anyone depends on it.
4. Add kit renderer diagnostics (Gap 1) and the `IpcBridge` prefix contract docs (Gap 6).
5. Everything else as polish.
