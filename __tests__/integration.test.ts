import { describe, expect, it } from "bun:test";
import * as S from "effect/Schema";
import { Cause, Effect, Exit } from "effect";
import * as ContextModule from "effect/Context";
import { defineContract, event, rpc } from "../src/contract.ts";
import { createEventPublisher, createRpcEndpoint } from "../src/main.ts";
import { createEventSubscriber, createRpcClient, RpcDefectError } from "../src/renderer.ts";
import type { ChannelPrefix, IpcMainLike } from "../src/types.ts";
import type { IpcEncodedValue, IpcTestListener } from "./test-support.ts";

class AccessDeniedError extends S.TaggedError<AccessDeniedError>()("AccessDeniedError", {
  message: S.String,
}) {}

const waitFor = async (predicate: () => boolean, timeoutMs = 1000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
};

const createRpcHarness = (prefix: ChannelPrefix = { rpc: "rpc/", event: "event/" }) => {
  const handlers = new Map<string, IpcTestListener>();

  const ipcMain: IpcMainLike = {
    handle: (channel, listener) => {
      handlers.set(channel, listener);
    },
    removeHandler: (channel) => {
      handlers.delete(channel);
    },
  };

  const invoke = async (method: string, payload: IpcEncodedValue) => {
    const handler = handlers.get(`${prefix.rpc}${method}`);
    if (!handler) {
      throw new Error(`Missing handler for method: ${method}`);
    }
    return handler({}, payload);
  };

  return {
    ipcMain,
    invoke,
    handlers,
  };
};

const createEventBusHarness = (prefix: ChannelPrefix = { rpc: "rpc/", event: "event/" }) => {
  const listeners = new Map<string, Set<(payload: IpcEncodedValue) => void>>();
  const sent: Array<{ channel: string; payload: IpcEncodedValue }> = [];

  const window = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, payload: IpcEncodedValue) => {
        sent.push({ channel, payload });
        const channelListeners = listeners.get(channel);
        if (!channelListeners) {
          return;
        }
        for (const listener of channelListeners) {
          listener(payload);
        }
      },
    },
  };

  const subscribe = (name: string, handler: (payload: IpcEncodedValue) => void) => {
    const channel = `${prefix.event}${name}`;
    const channelListeners =
      listeners.get(channel) ?? new Set<(payload: IpcEncodedValue) => void>();
    channelListeners.add(handler);
    listeners.set(channel, channelListeners);

    return () => {
      const next = listeners.get(channel);
      if (!next) {
        return;
      }
      next.delete(handler);
      if (next.size === 0) {
        listeners.delete(channel);
      }
    };
  };

  const listenerCount = () => {
    let count = 0;
    for (const set of listeners.values()) {
      count += set.size;
    }
    return count;
  };

  return {
    window,
    subscribe,
    sent,
    listenerCount,
  };
};

describe("integration", () => {
  it("when rpc calls roundtrip end-to-end, then success, typed failure, and defect behaviors are preserved", async () => {
    const Add = rpc("Add", S.Struct({ a: S.Number, b: S.Number }), S.Struct({ sum: S.Number }));
    const Fail = rpc("Fail", S.Struct({}), S.Struct({ ok: S.Boolean }), AccessDeniedError);
    const Crash = rpc("Crash", S.Struct({}), S.Struct({ ok: S.Boolean }));
    const contract = defineContract({
      methods: [Add, Fail, Crash] as const,
      events: [] as const,
    });

    const { ipcMain, invoke } = createRpcHarness();
    const endpoint = createRpcEndpoint(
      contract,
      ipcMain,
      {
        Add: ({ a, b }) => Effect.succeed({ sum: a + b }),
        Fail: () => Effect.fail(new AccessDeniedError({ message: "denied" })),
        Crash: () => Effect.die(new Error("boom")),
      },
      {
        context: ContextModule.empty(),
      },
    );
    endpoint.start();

    const client = createRpcClient(contract, { invoke });

    const add = await Effect.runPromise(client.Add({ a: 2, b: 3 }));
    expect(add).toEqual({ sum: 5 });

    const failExit = await Effect.runPromiseExit(client.Fail());
    if (Exit.isSuccess(failExit)) {
      throw new Error("Expected typed failure.");
    }
    const failCause = Cause.findErrorOption(failExit.cause);
    if (failCause._tag !== "Some") {
      throw new Error("Expected regular failure cause.");
    }
    expect(failCause.value).toBeInstanceOf(AccessDeniedError);

    const crashExit = await Effect.runPromiseExit(client.Crash());
    if (Exit.isSuccess(crashExit)) {
      throw new Error("Expected defect failure.");
    }
    const crashFailure = Cause.findErrorOption(crashExit.cause);
    if (crashFailure._tag !== "Some") {
      throw new Error("Expected regular failure cause.");
    }
    expect(crashFailure.value).toBeInstanceOf(RpcDefectError);
  });

  it("when main, preload, and renderer use matching custom prefixes, then rpc and event routing works end-to-end", async () => {
    const prefix = { rpc: "rpc-x/", event: "evt-x/" } as const;
    const Ping = rpc("Ping", S.Struct({}), S.Struct({ ok: S.Boolean }));
    const Progress = event("Progress", S.Struct({ step: S.Number }));
    const contract = defineContract({
      methods: [Ping] as const,
      events: [Progress] as const,
    });

    const { ipcMain, invoke } = createRpcHarness(prefix);
    const eventBus = createEventBusHarness(prefix);

    const endpoint = createRpcEndpoint(
      contract,
      ipcMain,
      {
        Ping: () => Effect.succeed({ ok: true }),
      },
      {
        context: ContextModule.empty(),
        channelPrefix: prefix,
      },
    );
    endpoint.start();

    const publisher = createEventPublisher(contract, {
      getWindows: () => [eventBus.window],
      channelPrefix: prefix,
    });
    publisher.start();

    const seen: Array<{ step: number }> = [];
    const subscriber = createEventSubscriber(contract, {
      subscribe: eventBus.subscribe,
    });
    subscriber.subscribe(Progress, (payload) => {
      seen.push(payload);
    });

    const client = createRpcClient(contract, { invoke });
    const ping = await Effect.runPromise(client.Ping());
    expect(ping).toEqual({ ok: true });

    await Effect.runPromise(publisher.publish(Progress, { step: 1 }));
    await waitFor(() => seen.length === 1);

    expect(seen).toEqual([{ step: 1 }]);
  });

  it("when events roundtrip end-to-end, then payload decoding integrity is preserved", async () => {
    const Progress = event(
      "Progress",
      S.Struct({
        value: S.Number,
        status: S.String,
      }),
    );
    const contract = defineContract({
      methods: [] as const,
      events: [Progress] as const,
    });

    const eventBus = createEventBusHarness();
    const publisher = createEventPublisher(contract, {
      getWindows: () => [eventBus.window],
    });
    const subscriber = createEventSubscriber(contract, {
      subscribe: eventBus.subscribe,
    });

    const seen: Array<{ value: number; status: string }> = [];
    subscriber.subscribe(Progress, (payload) => {
      seen.push(payload);
    });

    publisher.start();
    await Effect.runPromise(publisher.publish(Progress, { value: 10, status: "working" }));
    await waitFor(() => seen.length === 1);

    expect(seen).toEqual([{ value: 10, status: "working" }]);
  });

  it("when endpoint lifecycle is repeated across start and stop cycles, then no leak signals appear", async () => {
    const Ping = rpc("Ping", S.Struct({}), S.Struct({ ok: S.Boolean }));
    const Progress = event("Progress", S.Struct({ value: S.Number }));
    const contract = defineContract({
      methods: [Ping] as const,
      events: [Progress] as const,
    });

    const { ipcMain, handlers } = createRpcHarness();
    const eventBus = createEventBusHarness();

    const endpoint = createRpcEndpoint(
      contract,
      ipcMain,
      {
        Ping: () => Effect.succeed({ ok: true }),
      },
      {
        context: ContextModule.empty(),
      },
    );
    const publisher = createEventPublisher(contract, {
      getWindows: () => [eventBus.window],
    });
    const subscriber = createEventSubscriber(contract, {
      subscribe: eventBus.subscribe,
    });
    const seen: Array<{ value: number }> = [];
    subscriber.subscribe(Progress, (payload) => {
      seen.push(payload);
    });

    for (let i = 0; i < 20; i += 1) {
      endpoint.start();
      publisher.start();
      await Effect.runPromise(publisher.publish(Progress, { value: i }));
      await waitFor(() => seen.length === i + 1);
      publisher.stop();
      endpoint.stop();
      expect(handlers.size).toBe(0);
      expect(eventBus.listenerCount()).toBe(1);
    }

    subscriber.dispose();
    expect(eventBus.listenerCount()).toBe(0);
  });
});
