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

  it("keeps draining after dispatch failures", async () => {
    const dispatchFailures: unknown[] = [];
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
      },
    });

    publisher.start();

    await Effect.runPromise(publisher.publish(Progress, { value: 1 }));
    await Effect.runPromise(publisher.publish(Progress, { value: 2 }));

    await waitFor(() => sent.length === 1);

    expect(dispatchFailures.length).toBe(1);
    expect(sent[0]?.payload).toEqual({ value: 2 });
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
