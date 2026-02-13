import { describe, expect, it } from "bun:test";
import * as S from "@effect/schema/Schema";
import { Effect } from "effect";
import * as Runtime from "effect/Runtime";
import { createIpcKit, defineContract, event, rpc } from "../src/index.ts";
import type { ChannelPrefix, IpcMainLike } from "../src/types.ts";

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
  const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();

  const ipcMain: IpcMainLike = {
    handle: (channel, listener) => {
      handlers.set(channel, listener);
    },
    removeHandler: (channel) => {
      handlers.delete(channel);
    },
  };

  const invoke = async (method: string, payload: unknown) => {
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
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const sent: Array<{ channel: string; payload: unknown }> = [];

  const window = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, payload: unknown) => {
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

  const subscribe = (name: string, handler: (payload: unknown) => void) => {
    const channel = `${prefix.event}${name}`;
    const channelListeners = listeners.get(channel) ?? new Set<(payload: unknown) => void>();
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

  return {
    window,
    subscribe,
    sent,
  };
};

describe("createIpcKit", () => {
  it("when main and renderer are built from the same kit config, then rpc and events roundtrip end-to-end", async () => {
    const Ping = rpc("Ping", S.Struct({}), S.Struct({ ok: S.Boolean }));
    const Progress = event("Progress", S.Struct({ step: S.Number }));
    const contract = defineContract({
      methods: [Ping] as const,
      events: [Progress] as const,
    });

    const prefix = { rpc: "rpc-x/", event: "evt-x/" } as const;
    const kit = createIpcKit({
      contract,
      channelPrefix: prefix,
    });

    const rpcHarness = createRpcHarness(prefix);
    const eventHarness = createEventBusHarness(prefix);
    const main = kit.main({
      ipcMain: rpcHarness.ipcMain,
      handlers: {
        Ping: () => Effect.succeed({ ok: true }),
      },
      runtime: Runtime.defaultRuntime,
      getWindow: () => eventHarness.window,
    });
    main.start();

    const renderer = kit.renderer({
      invoke: rpcHarness.invoke,
      subscribe: eventHarness.subscribe,
    });

    const seen: Array<{ step: number }> = [];
    renderer.events.subscribe(Progress, (payload) => {
      seen.push(payload);
    });

    await expect(renderer.client.Ping()).resolves.toEqual({ ok: true });
    await main.emit(Progress, { step: 1 });
    await waitFor(() => seen.length === 1);

    expect(seen).toEqual([{ step: 1 }]);
    expect(rpcHarness.handlers.has("rpc-x/Ping")).toBe(true);
    expect(eventHarness.sent[0]).toEqual({
      channel: "evt-x/Progress",
      payload: { step: 1 },
    });
  });

  it("when lifecycle methods are called repeatedly, then start stop and dispose remain idempotent", () => {
    const Ping = rpc("Ping", S.Struct({}), S.Struct({ ok: S.Boolean }));
    const contract = defineContract({
      methods: [Ping] as const,
      events: [] as const,
    });

    const rpcHarness = createRpcHarness();
    const main = createIpcKit({ contract }).main({
      ipcMain: rpcHarness.ipcMain,
      handlers: {
        Ping: () => Effect.succeed({ ok: true }),
      },
      runtime: Runtime.defaultRuntime,
      getWindow: () => null,
    });

    expect(main.isRunning()).toBe(false);
    main.start();
    main.start();
    expect(main.isRunning()).toBe(true);
    expect(rpcHarness.handlers.size).toBe(1);

    main.stop();
    main.stop();
    expect(main.isRunning()).toBe(false);
    expect(rpcHarness.handlers.size).toBe(0);

    main.start();
    expect(main.isRunning()).toBe(true);
    expect(rpcHarness.handlers.size).toBe(1);

    main.dispose();
    main.dispose();
    expect(main.isRunning()).toBe(false);
    expect(rpcHarness.handlers.size).toBe(0);
    expect(() => main.start()).toThrow(/disposed/i);
  });

  it("when emitting through both APIs, then emit and publish both dispatch events", async () => {
    const Progress = event("Progress", S.Struct({ value: S.Number }));
    const contract = defineContract({
      methods: [] as const,
      events: [Progress] as const,
    });

    const eventHarness = createEventBusHarness();
    const main = createIpcKit({ contract }).main({
      ipcMain: {
        handle: () => {},
        removeHandler: () => {},
      },
      handlers: {},
      runtime: Runtime.defaultRuntime,
      getWindow: () => eventHarness.window,
    });
    main.start();

    const renderer = createIpcKit({ contract }).renderer({
      invoke: async () => ({ type: "success", data: {} }),
      subscribe: eventHarness.subscribe,
    });

    const seen: number[] = [];
    renderer.events.subscribe(Progress, (payload) => {
      seen.push(payload.value);
    });

    await main.emit(Progress, { value: 1 });
    await Effect.runPromise(main.publish(Progress, { value: 2 }));
    await waitFor(() => seen.length === 2);

    expect(seen).toEqual([1, 2]);
  });
});
