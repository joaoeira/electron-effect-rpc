# 03 - Events, Lifecycle, and Backpressure

Most Electron IPC failures are lifecycle bugs and queue-pressure bugs, not type
bugs. This guide focuses on those failure modes.

## Start with explicit lifecycle ownership

`createEventPublisher` and `createRpcEndpoint` return handles with `start`,
`stop`, `dispose`, and `isRunning`.

Use that explicitly in your app bootstrap:

```ts
const endpoint = createRpcEndpoint(contract, ipcMain, implementations, {
  runtime: Runtime.defaultRuntime,
});

const publisher = createEventPublisher(contract, {
  getWindows: () => [mainWindow],
});

endpoint.start();
publisher.start();
```

And explicitly on shutdown:

```ts
publisher.stop();
endpoint.stop();

publisher.dispose();
endpoint.dispose();
```

`stop` and `dispose` are idempotent. `dispose` is terminal.

## Understand queue behavior under pressure

The event publisher uses a bounded in-memory queue. When full, it drops the
oldest queued event before enqueueing the new one.

```ts
const publisher = createEventPublisher(contract, {
  getWindows: () => [mainWindow],
  maxQueueSize: 500,
  diagnostics: {
    onDroppedEvent: (context) => {
      logger.warn("event-dropped", context);
    },
    onDispatchFailure: (context) => {
      logger.error("event-dispatch-failed", context);
    },
  },
});
```

This is a freshness-first strategy, which is usually right for UI progress and
state notifications. If you need lossless streams, this transport is the wrong
tool without an application-level replay mechanism.

## Handle window availability honestly

If `getWindows()` returns an empty array during dispatch, the event is dropped
once. If individual windows are destroyed, each destroyed window increments the
drop counter independently. This is a deliberate reliability tradeoff to avoid
unbounded queues for unavailable renderers.

Use diagnostics to measure whether this is expected during startup transitions
or an indication of real delivery problems.

## Renderer subscriber decode modes

`createEventSubscriber` supports:

- `safe` (default): decode failures are reported to diagnostics and handler is not called.
- `strict`: decode failures throw immediately.

Be aware of what `strict` means in practice: the throw happens inside the
`ipcRenderer.on` callback, where no application code can catch it, so a decode
failure becomes an uncaught exception in the renderer. That is the point —
schema drift is impossible to ignore — but it will crash dev sessions, so use
`strict` in development and test-heavy surfaces only. Use `safe` in production
paths where you prefer telemetry and continued execution.

## Prefix consistency across process boundaries

If you customize channel prefixes, use the same values everywhere:

- main (`createRpcEndpoint` and publisher wiring)
- preload (`exposeRpcBridge` or `createBridgeAdapters`)
- renderer (`window.rpc.invoke` and `window.events.subscribe` source)

Prefix mismatch is the most common source of silent integration failure.

## Practical production checks

Watch `publisher.stats()` and diagnostics volume. A rising dropped count with
healthy renderer uptime usually means your queue is too small or your event rate
is too high for current dispatch throughput. Tune `maxQueueSize` and event
frequency based on those measurements, not guesswork.
