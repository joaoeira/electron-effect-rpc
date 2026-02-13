import { describe, expect, it } from "bun:test";
import * as S from "@effect/schema/Schema";
import { Effect } from "effect";
import { defineContract, event } from "../src/contract.ts";
import { createEventPublisher } from "../src/main.ts";
import { createEventSubscriber } from "../src/renderer.ts";

const waitFor = async (predicate: () => boolean, timeoutMs = 500) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
};

describe("createEventSubscriber", () => {
  const Progress = event("Progress", S.Struct({ value: S.Number }));

  const contract = defineContract({
    methods: [] as const,
    events: [Progress] as const,
  });

  it("requires a subscribe function", () => {
    expect(() => createEventSubscriber(contract)).toThrow(
      /EventSubscriberOptions.subscribe is required/
    );
  });

  it("uses safe mode by default and reports decode failures", () => {
    let listener: ((payload: unknown) => void) | undefined;
    const decodeFailures: unknown[] = [];

    const subscriber = createEventSubscriber(contract, {
      subscribe: (_name, handler) => {
        listener = handler;
        return () => {};
      },
      diagnostics: {
        onDecodeFailure: (context) => {
          decodeFailures.push(context);
        },
      },
    });

    const seen: Array<{ value: number }> = [];
    subscriber.subscribe(Progress, (payload) => {
      seen.push(payload);
    });

    expect(() => listener?.({})).not.toThrow();
    listener?.({ value: 1 });

    expect(seen).toEqual([{ value: 1 }]);
    expect(decodeFailures.length).toBe(1);
  });

  it("throws decode errors in strict mode", () => {
    let listener: ((payload: unknown) => void) | undefined;

    const subscriber = createEventSubscriber(contract, {
      subscribe: (_name, handler) => {
        listener = handler;
        return () => {};
      },
      decodeMode: "strict",
    });

    subscriber.subscribe(Progress, () => {});

    expect(() => listener?.({})).toThrow();
  });

  it("throws for unknown subscribeByName events", () => {
    const subscriber = createEventSubscriber(contract, {
      subscribe: () => () => {},
    });

    expect(() =>
      subscriber.subscribeByName("UnknownEvent", () => {})
    ).toThrow(/Unknown event: UnknownEvent/);
  });

  it("subscriber_subscribeByName_decodes_and_invokes_handler", () => {
    let listener: ((payload: unknown) => void) | undefined;

    const subscriber = createEventSubscriber(contract, {
      subscribe: (_name, handler) => {
        listener = handler;
        return () => {};
      },
    });

    const seen: unknown[] = [];
    subscriber.subscribeByName("Progress", (payload) => {
      seen.push(payload);
    });

    listener?.({ value: 42 });
    expect(seen).toEqual([{ value: 42 }]);
  });

  it("dispose unsubscribes active subscriptions", () => {
    let unsubscribeCalls = 0;

    const subscriber = createEventSubscriber(contract, {
      subscribe: () => () => {
        unsubscribeCalls += 1;
      },
    });

    subscriber.subscribe(Progress, () => {});
    subscriber.subscribeByName("Progress", () => {});

    subscriber.dispose();
    expect(unsubscribeCalls).toBe(2);
  });

  it("subscriber_unsubscribe_is_idempotent", () => {
    let unsubscribeCalls = 0;

    const subscriber = createEventSubscriber(contract, {
      subscribe: () => () => {
        unsubscribeCalls += 1;
      },
    });

    const unsubscribe = subscriber.subscribe(Progress, () => {});
    unsubscribe();
    unsubscribe();

    expect(unsubscribeCalls).toBe(1);
  });

  it("subscriber_no_handler_calls_after_unsubscribe", () => {
    const listeners = new Set<(payload: unknown) => void>();

    const subscriber = createEventSubscriber(contract, {
      subscribe: (_name, handler) => {
        listeners.add(handler);
        return () => {
          listeners.delete(handler);
        };
      },
    });

    const seen: Array<{ value: number }> = [];
    const unsubscribe = subscriber.subscribe(Progress, (payload) => {
      seen.push(payload);
    });

    for (const listener of listeners) {
      listener({ value: 1 });
    }
    unsubscribe();
    for (const listener of listeners) {
      listener({ value: 2 });
    }

    expect(seen).toEqual([{ value: 1 }]);
  });

  it("subscriber_no_handler_calls_after_dispose", () => {
    const listeners = new Set<(payload: unknown) => void>();

    const subscriber = createEventSubscriber(contract, {
      subscribe: (_name, handler) => {
        listeners.add(handler);
        return () => {
          listeners.delete(handler);
        };
      },
    });

    const seen: Array<{ value: number }> = [];
    subscriber.subscribe(Progress, (payload) => {
      seen.push(payload);
    });

    for (const listener of listeners) {
      listener({ value: 1 });
    }
    subscriber.dispose();
    for (const listener of listeners) {
      listener({ value: 2 });
    }

    expect(seen).toEqual([{ value: 1 }]);
  });

  it("dispose attempts all unsubscribes even if one throws", () => {
    const calls: string[] = [];
    const unsubscribes = [
      () => {
        calls.push("first");
        throw new Error("first unsubscribe failed");
      },
      () => {
        calls.push("second");
      },
    ];

    let index = 0;
    const subscriber = createEventSubscriber(contract, {
      subscribe: () => unsubscribes[index++] ?? (() => {}),
    });

    subscriber.subscribe(Progress, () => {});
    subscriber.subscribeByName("Progress", () => {});

    expect(() => subscriber.dispose()).toThrow(/first unsubscribe failed/);
    expect(calls).toEqual(["first", "second"]);
  });
});

describe("createEventPublisher", () => {
  const Progress = event("Progress", S.Struct({ value: S.Number }));

  const contract = defineContract({
    methods: [] as const,
    events: [Progress] as const,
  });

  it("dispatches encoded events to renderer listeners once started", async () => {
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const windowStub = {
      isDestroyed: () => false,
      webContents: {
        send: (channel: string, payload: unknown) => {
          sent.push({ channel, payload });
        },
      },
    };

    const publisher = createEventPublisher(contract, {
      getWindow: () => windowStub,
    });

    await Effect.runPromise(publisher.publish(Progress, { value: 1 }));
    expect(sent).toEqual([]);

    publisher.start();
    await waitFor(() => sent.length === 1);

    expect(sent[0]).toEqual({
      channel: "event/Progress",
      payload: { value: 1 },
    });
  });

  it("publisher_rejects_invalid_maxQueueSize_zero", () => {
    expect(() =>
      createEventPublisher(contract, {
        getWindow: () => null,
        maxQueueSize: 0,
      })
    ).toThrow(/positive finite number/);
  });

  it("publisher_rejects_invalid_maxQueueSize_negative", () => {
    expect(() =>
      createEventPublisher(contract, {
        getWindow: () => null,
        maxQueueSize: -2,
      })
    ).toThrow(/positive finite number/);
  });

  it("publisher_rejects_invalid_maxQueueSize_infinite_or_nan", () => {
    expect(() =>
      createEventPublisher(contract, {
        getWindow: () => null,
        maxQueueSize: Number.POSITIVE_INFINITY,
      })
    ).toThrow(/positive finite number/);

    expect(() =>
      createEventPublisher(contract, {
        getWindow: () => null,
        maxQueueSize: Number.NaN,
      })
    ).toThrow(/positive finite number/);
  });

  it("uses custom event channel prefixes", async () => {
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const windowStub = {
      isDestroyed: () => false,
      webContents: {
        send: (channel: string, payload: unknown) => {
          sent.push({ channel, payload });
        },
      },
    };

    const publisher = createEventPublisher(contract, {
      getWindow: () => windowStub,
      channelPrefix: {
        rpc: "rpc-custom/",
        event: "evt-custom/",
      },
    });

    publisher.start();
    await Effect.runPromise(publisher.publish(Progress, { value: 2 }));
    await waitFor(() => sent.length === 1);

    expect(sent[0]).toEqual({
      channel: "evt-custom/Progress",
      payload: { value: 2 },
    });
  });

  it("publisher_fifo_delivery_order_is_preserved", async () => {
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const windowStub = {
      isDestroyed: () => false,
      webContents: {
        send: (channel: string, payload: unknown) => {
          sent.push({ channel, payload });
        },
      },
    };

    const publisher = createEventPublisher(contract, {
      getWindow: () => windowStub,
    });

    publisher.start();
    await Effect.runPromise(publisher.publish(Progress, { value: 1 }));
    await Effect.runPromise(publisher.publish(Progress, { value: 2 }));
    await Effect.runPromise(publisher.publish(Progress, { value: 3 }));

    await waitFor(() => sent.length === 3);
    expect(sent.map((entry) => entry.payload)).toEqual([
      { value: 1 },
      { value: 2 },
      { value: 3 },
    ]);
  });

  it("drops oldest queued events when maxQueueSize is reached", async () => {
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const dropped: unknown[] = [];

    const windowStub = {
      isDestroyed: () => false,
      webContents: {
        send: (channel: string, payload: unknown) => {
          sent.push({ channel, payload });
        },
      },
    };

    const publisher = createEventPublisher(contract, {
      getWindow: () => windowStub,
      maxQueueSize: 2,
      diagnostics: {
        onDroppedEvent: (context) => {
          dropped.push(context);
        },
      },
    });

    await Effect.runPromise(publisher.publish(Progress, { value: 1 }));
    await Effect.runPromise(publisher.publish(Progress, { value: 2 }));
    await Effect.runPromise(publisher.publish(Progress, { value: 3 }));

    expect(publisher.stats()).toEqual({ queued: 2, dropped: 1 });
    expect(dropped.length).toBe(1);

    publisher.start();
    await waitFor(() => sent.length === 2);

    expect(sent.map((entry) => entry.payload)).toEqual([
      { value: 2 },
      { value: 3 },
    ]);
  });

  it("records drops when no renderer window is available during dispatch", async () => {
    const dropped: unknown[] = [];

    const publisher = createEventPublisher(contract, {
      getWindow: () => null,
      diagnostics: {
        onDroppedEvent: (context) => {
          dropped.push(context);
        },
      },
    });

    publisher.start();
    await Effect.runPromise(publisher.publish(Progress, { value: 1 }));
    await waitFor(() => publisher.stats().dropped === 1);

    expect(publisher.stats()).toEqual({ queued: 0, dropped: 1 });
    expect(dropped).toEqual([
      {
        event: "Progress",
        payload: { value: 1 },
        reason: "window_unavailable",
        queued: 0,
        dropped: 1,
      },
    ]);
  });

  it("publisher_records_drop_when_window_is_destroyed", async () => {
    const dropped: unknown[] = [];
    const publisher = createEventPublisher(contract, {
      getWindow: () => ({
        isDestroyed: () => true,
        webContents: {
          send: () => {},
        },
      }),
      diagnostics: {
        onDroppedEvent: (context) => {
          dropped.push(context);
        },
      },
    });

    publisher.start();
    await Effect.runPromise(publisher.publish(Progress, { value: 1 }));
    await waitFor(() => publisher.stats().dropped === 1);

    expect(dropped).toEqual([
      {
        event: "Progress",
        payload: { value: 1 },
        reason: "window_unavailable",
        queued: 0,
        dropped: 1,
      },
    ]);
  });

  it("publisher_records_drop_on_encoding_failure", async () => {
    const dropped: unknown[] = [];
    const decodeFailures: unknown[] = [];
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const windowStub = {
      isDestroyed: () => false,
      webContents: {
        send: (channel: string, payload: unknown) => {
          sent.push({ channel, payload });
        },
      },
    };

    const publisher = createEventPublisher(contract, {
      getWindow: () => windowStub,
      diagnostics: {
        onDroppedEvent: (context) => {
          dropped.push(context);
        },
        onDecodeFailure: (context) => {
          decodeFailures.push(context);
        },
      },
    });

    publisher.start();
    await Effect.runPromise(
      publisher.publish(Progress, { value: "bad-number" } as never)
    );
    await waitFor(() => publisher.stats().dropped === 1);

    expect(sent).toEqual([]);
    expect(decodeFailures).toHaveLength(1);
    expect(dropped).toEqual([
      {
        event: "Progress",
        payload: { value: "bad-number" },
        reason: "encoding_failed",
        queued: 0,
        dropped: 1,
      },
    ]);
  });

  it("publisher_stop_pauses_dispatch_but_keeps_queue", async () => {
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const windowStub = {
      isDestroyed: () => false,
      webContents: {
        send: (channel: string, payload: unknown) => {
          sent.push({ channel, payload });
        },
      },
    };

    const publisher = createEventPublisher(contract, {
      getWindow: () => windowStub,
    });

    publisher.start();
    publisher.stop();
    await Effect.runPromise(publisher.publish(Progress, { value: 7 }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sent).toEqual([]);
    expect(publisher.stats()).toEqual({ queued: 1, dropped: 0 });
  });

  it("publisher_restart_resumes_drain", async () => {
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const windowStub = {
      isDestroyed: () => false,
      webContents: {
        send: (channel: string, payload: unknown) => {
          sent.push({ channel, payload });
        },
      },
    };

    const publisher = createEventPublisher(contract, {
      getWindow: () => windowStub,
    });

    publisher.start();
    publisher.stop();
    await Effect.runPromise(publisher.publish(Progress, { value: 9 }));
    expect(publisher.stats().queued).toBe(1);

    publisher.start();
    await waitFor(() => sent.length === 1);

    expect(sent[0]?.payload).toEqual({ value: 9 });
    expect(publisher.stats()).toEqual({ queued: 0, dropped: 0 });
  });

  it("publisher_publish_after_dispose_is_noop", async () => {
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const windowStub = {
      isDestroyed: () => false,
      webContents: {
        send: (channel: string, payload: unknown) => {
          sent.push({ channel, payload });
        },
      },
    };

    const publisher = createEventPublisher(contract, {
      getWindow: () => windowStub,
    });

    publisher.start();
    publisher.dispose();

    await Effect.runPromise(publisher.publish(Progress, { value: 1 }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sent).toEqual([]);
    expect(publisher.stats()).toEqual({ queued: 0, dropped: 0 });
  });

  it("keeps draining after dispatch failures", async () => {
    const dispatchFailures: unknown[] = [];
    const dropped: unknown[] = [];
    const sent: Array<{ channel: string; payload: unknown }> = [];

    let attempt = 0;
    const windowStub = {
      isDestroyed: () => false,
      webContents: {
        send: (channel: string, payload: unknown) => {
          attempt += 1;
          if (attempt === 1) {
            throw new Error("transient send failure");
          }

          sent.push({ channel, payload });
        },
      },
    };

    const publisher = createEventPublisher(contract, {
      getWindow: () => windowStub,
      diagnostics: {
        onDispatchFailure: (context) => {
          dispatchFailures.push(context);
        },
        onDroppedEvent: (context) => {
          dropped.push(context);
        },
      },
    });

    publisher.start();

    await Effect.runPromise(publisher.publish(Progress, { value: 1 }));
    await Effect.runPromise(publisher.publish(Progress, { value: 2 }));

    await waitFor(() => sent.length === 1);

    expect(dispatchFailures.length).toBe(1);
    expect(dropped).toEqual([
      {
        event: "Progress",
        payload: { value: 1 },
        reason: "dispatch_failed",
        queued: 0,
        dropped: 1,
      },
    ]);
    expect(publisher.stats()).toEqual({ queued: 0, dropped: 1 });
    expect(sent[0]?.payload).toEqual({ value: 2 });
  });

  it("publisher_dispatch_failure_reports_dispatch_and_drop_diagnostics_consistently", async () => {
    const dispatchFailures: unknown[] = [];
    const dropped: unknown[] = [];

    const windowStub = {
      isDestroyed: () => false,
      webContents: {
        send: () => {
          throw new Error("send-failed");
        },
      },
    };

    const publisher = createEventPublisher(contract, {
      getWindow: () => windowStub,
      diagnostics: {
        onDispatchFailure: (context) => {
          dispatchFailures.push(context);
        },
        onDroppedEvent: (context) => {
          dropped.push(context);
        },
      },
    });

    publisher.start();
    await Effect.runPromise(publisher.publish(Progress, { value: 1 }));
    await waitFor(() => publisher.stats().dropped === 1);

    expect(dispatchFailures).toHaveLength(1);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({
      event: "Progress",
      payload: { value: 1 },
      reason: "dispatch_failed",
      dropped: 1,
    });
  });

  it("publisher_stats_dropped_is_monotonic", async () => {
    const droppedCounts: number[] = [];
    let sendAttempt = 0;

    const publisher = createEventPublisher(contract, {
      getWindow: () => ({
        isDestroyed: () => false,
        webContents: {
          send: () => {
            sendAttempt += 1;
            if (sendAttempt <= 2) {
              throw new Error("dispatch-fail");
            }
          },
        },
      }),
      maxQueueSize: 2,
    });

    publisher.start();
    await Effect.runPromise(publisher.publish(Progress, { value: 1 }));
    droppedCounts.push(publisher.stats().dropped);
    await Effect.runPromise(publisher.publish(Progress, { value: 2 }));
    droppedCounts.push(publisher.stats().dropped);
    await Effect.runPromise(publisher.publish(Progress, { value: 3 }));
    droppedCounts.push(publisher.stats().dropped);

    expect(droppedCounts[0]).toBeLessThanOrEqual(droppedCounts[1] ?? 0);
    expect(droppedCounts[1]).toBeLessThanOrEqual(droppedCounts[2] ?? 0);
  });

  it("is idempotent on stop/dispose and rejects restart after dispose", () => {
    const windowStub = {
      isDestroyed: () => false,
      webContents: {
        send: () => {},
      },
    };

    const publisher = createEventPublisher(contract, {
      getWindow: () => windowStub,
    });

    publisher.start();
    publisher.stop();
    publisher.stop();
    publisher.dispose();
    publisher.dispose();

    expect(() => publisher.start()).toThrow(/disposed/i);
  });
});
