import { beforeEach, describe, expect, it, mock } from "bun:test";

type ExposedGlobals = Record<string, Record<string, unknown>>;

const exposedGlobals: ExposedGlobals = Object.create(null);
const invokeCalls: Array<{ channel: string; payload: unknown }> = [];
const onCalls: Array<{ channel: string; handler: (event: unknown, payload: unknown) => void }> =
  [];
const removeCalls: Array<{
  channel: string;
  handler: (event: unknown, payload: unknown) => void;
}> = [];

const electronModule = {
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
    removeListener: (
      channel: string,
      handler: (event: unknown, payload: unknown) => void
    ) => {
      removeCalls.push({ channel, handler });
    },
  },
};

mock.module("electron", () => electronModule);

const { createBridgeAdapters, exposeRpcBridge } = await import("../src/preload.ts");

describe("preload bridge", () => {
  beforeEach(() => {
    invokeCalls.length = 0;
    onCalls.length = 0;
    removeCalls.length = 0;
    for (const key of Object.keys(exposedGlobals)) {
      delete exposedGlobals[key];
    }
  });

  it("when createBridgeAdapters is called without options, then default channel prefixes are used", async () => {
    const adapters = createBridgeAdapters();

    await adapters.invoke("Ping", { id: 1 });
    adapters.subscribe("Progress", () => {});

    expect(invokeCalls).toEqual([{ channel: "rpc/Ping", payload: { id: 1 } }]);
    expect(onCalls).toHaveLength(1);
    expect(onCalls[0]?.channel).toBe("event/Progress");
  });

  it("when createBridgeAdapters receives custom prefixes, then invoke and subscribe use those prefixes", async () => {
    const adapters = createBridgeAdapters({
      channelPrefix: { rpc: "rpc-custom/", event: "evt-custom/" },
    });

    await adapters.invoke("Ping", {});
    adapters.subscribe("Progress", () => {});

    expect(invokeCalls).toEqual([{ channel: "rpc-custom/Ping", payload: {} }]);
    expect(onCalls).toHaveLength(1);
    expect(onCalls[0]?.channel).toBe("evt-custom/Progress");
  });

  it("when bridge invoke is called, then ipcRenderer.invoke receives the prefixed channel", async () => {
    const adapters = createBridgeAdapters();

    await adapters.invoke("DoThing", { ok: true });

    expect(invokeCalls).toEqual([
      {
        channel: "rpc/DoThing",
        payload: { ok: true },
      },
    ]);
  });

  it("when bridge subscribe is called, then listener is registered on the prefixed channel", () => {
    const adapters = createBridgeAdapters();
    const seen: unknown[] = [];
    adapters.subscribe("Stream", (payload) => {
      seen.push(payload);
    });

    expect(onCalls).toHaveLength(1);
    expect(onCalls[0]?.channel).toBe("event/Stream");

    onCalls[0]?.handler({}, { tick: 1 });
    expect(seen).toEqual([{ tick: 1 }]);
  });

  it("when unsubscribe is called, then the exact wrapped listener is removed", () => {
    const adapters = createBridgeAdapters();

    const unsubscribe = adapters.subscribe("Stream", () => {});
    const subscribed = onCalls[0];
    if (!subscribed) {
      throw new Error("expected a registered listener");
    }

    unsubscribe();

    expect(removeCalls).toHaveLength(1);
    expect(removeCalls[0]).toEqual({
      channel: "event/Stream",
      handler: subscribed.handler,
    });
  });

  it("when exposeRpcBridge is called with defaults, then rpc and events globals are exposed", () => {
    exposeRpcBridge();

    expect(Object.keys(exposedGlobals).sort()).toEqual(["events", "rpc"]);
    expect(typeof exposedGlobals.rpc?.invoke).toBe("function");
    expect(typeof exposedGlobals.events?.subscribe).toBe("function");
  });

  it("when exposeRpcBridge receives custom global names, then those names are exposed", () => {
    exposeRpcBridge({
      rpcGlobal: "rpcApi",
      eventsGlobal: "rpcEvents",
    });

    expect(Object.keys(exposedGlobals).sort()).toEqual(["rpcApi", "rpcEvents"]);
    expect(typeof exposedGlobals.rpcApi?.invoke).toBe("function");
    expect(typeof exposedGlobals.rpcEvents?.subscribe).toBe("function");
  });

  it("when exposeRpcBridge receives custom prefixes, then exposed adapters use those prefixes", async () => {
    exposeRpcBridge({
      rpcGlobal: "rpcApi",
      eventsGlobal: "rpcEvents",
      channelPrefix: { rpc: "rpc-x/", event: "evt-x/" },
    });

    const invoke = exposedGlobals.rpcApi?.invoke as
      | ((method: string, payload: unknown) => Promise<unknown>)
      | undefined;
    const subscribe = exposedGlobals.rpcEvents?.subscribe as
      | ((name: string, listener: (payload: unknown) => void) => () => void)
      | undefined;

    if (!invoke || !subscribe) {
      throw new Error("expected bridge globals");
    }

    await invoke("Method", { v: 1 });
    const unsubscribe = subscribe("Progress", () => {});
    unsubscribe();

    expect(invokeCalls).toEqual([{ channel: "rpc-x/Method", payload: { v: 1 } }]);
    expect(onCalls[0]?.channel).toBe("evt-x/Progress");
    expect(removeCalls[0]?.channel).toBe("evt-x/Progress");
  });
});
