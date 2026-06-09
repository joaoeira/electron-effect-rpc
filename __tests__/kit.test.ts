import { describe, expect, it, mock } from "bun:test";
import * as S from "effect/Schema";
import { Effect } from "effect";
import * as Runtime from "effect/Runtime";
import { createIpcKit, defineContract, event, rpc } from "../src/index.ts";
import type { ChannelPrefix, IpcMainLike } from "../src/types.ts";

const exposedGlobals: Record<string, Record<string, unknown>> = Object.create(null);
const invokeCalls: Array<{ channel: string; payload: unknown }> = [];
const onCalls: Array<{
  channel: string;
  handler: (event: unknown, payload: unknown) => void;
}> = [];
const removeCalls: Array<{
  channel: string;
  handler: (event: unknown, payload: unknown) => void;
}> = [];

mock.module("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, value: Record<string, unknown>) => {
      exposedGlobals[name] = value;
    },
  },
  ipcRenderer: {
    invoke: (channel: string, payload: unknown) => {
      invokeCalls.push({ channel, payload });
      return Promise.resolve({ ok: true });
    },
    on: (channel: string, handler: (event: unknown, payload: unknown) => void) => {
      onCalls.push({ channel, handler });
    },
    removeListener: (channel: string, handler: (event: unknown, payload: unknown) => void) => {
      removeCalls.push({ channel, handler });
    },
  },
}));

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
  it("when rpc and event prefixes are identical, then createIpcKit throws", () => {
    const Ping = rpc("Ping", S.Struct({}), S.Struct({ ok: S.Boolean }));
    const contract = defineContract({
      methods: [Ping] as const,
      events: [] as const,
    });

    expect(() =>
      createIpcKit({
        contract,
        channelPrefix: { rpc: "ipc/", event: "ipc/" },
      }),
    ).toThrow(/must differ/);
  });

  it("when preload bridge is created from kit, then return value is synchronous and uses shared config", async () => {
    invokeCalls.length = 0;
    onCalls.length = 0;
    removeCalls.length = 0;
    for (const key of Object.keys(exposedGlobals)) {
      delete exposedGlobals[key];
    }

    const Ping = rpc("Ping", S.Struct({}), S.Struct({ ok: S.Boolean }));
    const Progress = event("Progress", S.Struct({ step: S.Number }));
    const contract = defineContract({
      methods: [Ping] as const,
      events: [Progress] as const,
    });

    const kit = createIpcKit({
      contract,
      channelPrefix: {
        rpc: "rpc-kit/",
        event: "evt-kit/",
      },
      bridge: {
        global: "bridgeKit",
      },
    });

    const preload = kit.preload();
    expect(preload).not.toBeInstanceOf(Promise);
    expect(preload.global).toBe("bridgeKit");

    preload.expose();

    const invokeRaw = exposedGlobals.bridgeKit?.invoke;
    const subscribeRaw = exposedGlobals.bridgeKit?.subscribe;
    if (typeof invokeRaw !== "function" || typeof subscribeRaw !== "function") {
      throw new Error("expected exposed preload bridge");
    }

    await invokeRaw("Ping", { ok: true });
    const unsubscribe = subscribeRaw("Progress", () => {});
    unsubscribe();

    expect(invokeCalls).toEqual([{ channel: "rpc-kit/Ping", payload: { ok: true } }]);
    expect(onCalls[0]?.channel).toBe("evt-kit/Progress");
    expect(removeCalls[0]?.channel).toBe("evt-kit/Progress");
  });

  it("when electronModule is supplied, then kit preload uses supplied bindings", async () => {
    const localExposedGlobals: Record<string, Record<string, unknown>> = Object.create(null);
    const localInvokeCalls: Array<{ channel: string; payload: unknown }> = [];
    const localOnCalls: Array<{
      channel: string;
      handler: (event: unknown, payload: unknown) => void;
    }> = [];
    const localRemoveCalls: Array<{
      channel: string;
      handler: (event: unknown, payload: unknown) => void;
    }> = [];

    const localElectronModule = {
      contextBridge: {
        exposeInMainWorld: (name: string, value: Record<string, unknown>) => {
          localExposedGlobals[name] = value;
        },
      },
      ipcRenderer: {
        invoke: (channel: string, payload: unknown) => {
          localInvokeCalls.push({ channel, payload });
          return Promise.resolve({ ok: true });
        },
        on: (channel: string, handler: (event: unknown, payload: unknown) => void) => {
          localOnCalls.push({ channel, handler });
        },
        removeListener: (channel: string, handler: (event: unknown, payload: unknown) => void) => {
          localRemoveCalls.push({ channel, handler });
        },
      },
    };

    const Ping = rpc("Ping", S.Struct({}), S.Struct({ ok: S.Boolean }));
    const Progress = event("Progress", S.Struct({ step: S.Number }));
    const contract = defineContract({
      methods: [Ping] as const,
      events: [Progress] as const,
    });

    const kit = createIpcKit({
      contract,
      channelPrefix: {
        rpc: "rpc-local/",
        event: "evt-local/",
      },
    });

    const preload = kit.preload({
      global: "localApi",
      electronModule: localElectronModule,
    });
    preload.expose();

    const invokeRaw = localExposedGlobals.localApi?.invoke;
    const subscribeRaw = localExposedGlobals.localApi?.subscribe;
    if (typeof invokeRaw !== "function" || typeof subscribeRaw !== "function") {
      throw new Error("expected exposed local preload bridge");
    }

    await invokeRaw("Ping", { from: "override" });
    const unsubscribe = subscribeRaw("Progress", () => {});
    unsubscribe();

    expect(localInvokeCalls).toEqual([
      { channel: "rpc-local/Ping", payload: { from: "override" } },
    ]);
    expect(localOnCalls[0]?.channel).toBe("evt-local/Progress");
    expect(localRemoveCalls[0]?.channel).toBe("evt-local/Progress");
  });

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
      getWindows: () => [eventHarness.window],
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

    const ping = await Effect.runPromise(renderer.client.Ping());
    expect(ping).toEqual({ ok: true });
    await Effect.runPromise(main.publish(Progress, { step: 1 }));
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
      getWindows: () => [],
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

  it("when publishing from main handle, then events dispatch to renderer subscribers", async () => {
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
      getWindows: () => [eventHarness.window],
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

    await Effect.runPromise(main.publish(Progress, { value: 1 }));
    await waitFor(() => seen.length === 1);

    expect(seen).toEqual([1]);
  });
});

describe("kit renderer diagnostics", () => {
  it("when renderer diagnostics are provided, then rpc decode failures are reported", async () => {
    const Ping = rpc("Ping", S.Struct({}), S.Struct({ ok: S.Boolean }));
    const contract = defineContract({
      methods: [Ping] as const,
      events: [] as const,
    });

    const decodeFailures: Array<{ scope: string; name: string }> = [];

    const renderer = createIpcKit({ contract }).renderer(
      {
        invoke: async () => ({ type: "success", data: { ok: "not-a-boolean" } }),
        subscribe: () => () => {},
      },
      {
        diagnostics: {
          rpc: {
            onDecodeFailure: (context) => {
              decodeFailures.push({ scope: context.scope, name: context.name });
            },
          },
        },
      },
    );

    const exit = await Effect.runPromiseExit(renderer.client.Ping());
    expect(exit._tag).toBe("Failure");
    expect(decodeFailures).toEqual([{ scope: "rpc-response", name: "Ping" }]);
  });
});
