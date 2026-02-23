import { describe, expect, it } from "bun:test";
import * as S from "@effect/schema/Schema";
import { Cause, Effect, Stream } from "effect";
import * as Runtime from "effect/Runtime";
import { defineContract, rpc, streamRpc } from "../src/contract.ts";
import { createRpcEndpoint } from "../src/main.ts";
import { isRecord, parseStreamFrame, type StreamFrame } from "../src/protocol.ts";
import { createStreamRpcClient, RpcDefectError } from "../src/renderer.ts";
import { createIpcKit } from "../src/index.ts";
import type { IpcMainLike, OnStreamFrame } from "../src/types.ts";

class StreamError extends S.TaggedError<StreamError>()("StreamError", {
  message: S.String,
}) {}

const createStreamHarness = (prefix = { rpc: "rpc/", event: "event/" }) => {
  const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();

  const ipcMain: IpcMainLike = {
    handle: (channel, listener) => {
      handlers.set(channel, listener);
    },
    removeHandler: (channel) => {
      handlers.delete(channel);
    },
  };

  // Simulate sender
  let senderDestroyed = false;
  const sentFrames: Array<{ channel: string; payload: unknown }> = [];

  // Frame listeners (simulating ipcRenderer.on for the sf channel)
  const frameListeners = new Set<(frame: unknown) => void>();

  const mockSender = {
    id: 1,
    isDestroyed: () => senderDestroyed,
    send: (channel: string, payload: unknown) => {
      sentFrames.push({ channel, payload });
      // Dispatch to any registered frame listeners
      if (channel === `${prefix.rpc}sf`) {
        for (const listener of frameListeners) {
          listener(payload);
        }
      }
    },
  };

  const mockEvent = { sender: mockSender };

  const invoke = async (method: string, payload: unknown) => {
    const handler = handlers.get(`${prefix.rpc}${method}`);
    if (!handler) {
      throw new Error(`Missing handler for method: ${method}`);
    }
    return handler(mockEvent, payload);
  };

  const onStreamFrame: OnStreamFrame = (listener) => {
    frameListeners.add(listener);
    return () => {
      frameListeners.delete(listener);
    };
  };

  return {
    ipcMain,
    handlers,
    invoke,
    onStreamFrame,
    mockSender,
    mockEvent,
    sentFrames,
    setSenderDestroyed: (v: boolean) => {
      senderDestroyed = v;
    },
    frameListeners,
  };
};

const createScheduledFrameBridge = ({
  totalFrames,
  framesPerTick = 1,
  tickDelayMs = 0,
  tailFramesAfterEnd = 0,
}: {
  totalFrames: number;
  framesPerTick?: number;
  tickDelayMs?: number;
  tailFramesAfterEnd?: number;
}) => {
  const listeners = new Set<(frame: unknown) => void>();
  const cancelled = new Set<string>();
  const cancelCalls: string[] = [];
  const startedStreamIds: string[] = [];

  const onStreamFrame: OnStreamFrame = (listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const emitFrame = (frame: unknown) => {
    for (const listener of listeners) {
      listener(frame);
    }
  };

  const invoke = async (method: string, payload: unknown) => {
    if (method === "stream-cancel") {
      if (isRecord(payload) && typeof payload.streamId === "string") {
        cancelCalls.push(payload.streamId);
        cancelled.add(payload.streamId);
      }
      return { cancelled: true };
    }
    if (!method.startsWith("stream/")) {
      return { type: "success", data: {} };
    }

    if (!isRecord(payload) || typeof payload.streamId !== "string") {
      throw new Error("Missing streamId in stream invoke payload");
    }
    const streamId = payload.streamId;
    startedStreamIds.push(streamId);

    let sent = 0;

    const pump = () => {
      if (cancelled.has(streamId)) {
        return;
      }

      const nextBatchSize = Math.min(framesPerTick, totalFrames - sent);
      for (let i = 0; i < nextBatchSize; i += 1) {
        emitFrame({ type: "data", streamId, payload: { value: sent + i } });
      }
      sent += nextBatchSize;

      if (sent >= totalFrames) {
        emitFrame({ type: "end", streamId });
        for (let i = 0; i < tailFramesAfterEnd; i += 1) {
          emitFrame({ type: "data", streamId, payload: { value: totalFrames + i } });
        }
        return;
      }

      setTimeout(pump, tickDelayMs);
    };

    setTimeout(pump, tickDelayMs);

    return {
      type: "success",
      data: { type: "stream_started" },
    };
  };

  return {
    invoke,
    onStreamFrame,
    cancelCalls,
    startedStreamIds,
    emitFrame,
  };
};

const waitFor = async (predicate: () => boolean, timeoutMs = 2000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("Timed out waiting for condition");
};

/** Safely parse the payload of a sent frame. Returns null if not a valid StreamFrame. */
const asFrame = (f: { payload: unknown }): StreamFrame | null => parseStreamFrame(f.payload);

/** Extract streamId from a frame payload using isRecord. */
const extractStreamId = (payload: unknown): string => {
  if (isRecord(payload) && typeof payload.streamId === "string") {
    return payload.streamId;
  }
  throw new Error("Expected payload with streamId");
};

/** Safely narrow an unknown error value to RpcDefectError after instanceof check. */
const asRpcDefect = (value: unknown): RpcDefectError => {
  if (!(value instanceof RpcDefectError)) {
    throw new Error(`Expected RpcDefectError, got: ${typeof value}`);
  }
  return value;
};

const StreamAdd = streamRpc(
  "StreamAdd",
  S.Struct({ count: S.Number }),
  S.Struct({ value: S.Number }),
);

const StreamFail = streamRpc(
  "StreamFail",
  S.Struct({}),
  S.Struct({ delta: S.String }),
  StreamError,
);

const Ping = rpc("Ping", S.Struct({}), S.Struct({ ok: S.Boolean }));

const contract = defineContract({
  methods: [Ping] as const,
  events: [] as const,
  streamMethods: [StreamAdd, StreamFail] as const,
});

// Contract tests

describe("streamRpc contract", () => {
  it("when streamRpc is defined, then it has _tag StreamRpcMethod", () => {
    expect(StreamAdd._tag).toBe("StreamRpcMethod");
    expect(StreamAdd.name).toBe("StreamAdd");
  });

  it("when defineContract includes streamMethods, then they are preserved", () => {
    expect(contract.streamMethods).toHaveLength(2);
    expect(contract.streamMethods[0].name).toBe("StreamAdd");
    expect(contract.streamMethods[1].name).toBe("StreamFail");
  });

  it("when stream method name collides with rpc method, then defineContract throws", () => {
    expect(() =>
      defineContract({
        methods: [Ping] as const,
        events: [] as const,
        streamMethods: [streamRpc("Ping", S.Struct({}), S.Struct({}))] as const,
      }),
    ).toThrow(/Name collision between methods and streamMethods: Ping/);
  });

  it("when stream method names are duplicated, then defineContract throws", () => {
    expect(() =>
      defineContract({
        methods: [] as const,
        events: [] as const,
        streamMethods: [StreamAdd, StreamAdd],
      }),
    ).toThrow(/Duplicate stream method name/);
  });

  it("when stream method name is reserved, then defineContract throws", () => {
    expect(() =>
      defineContract({
        methods: [] as const,
        events: [] as const,
        streamMethods: [streamRpc("sf", S.Struct({}), S.Struct({}))] as const,
      }),
    ).toThrow(/reserved for internal stream transport/);

    expect(() =>
      defineContract({
        methods: [] as const,
        events: [] as const,
        streamMethods: [streamRpc("stream-cancel", S.Struct({}), S.Struct({}))] as const,
      }),
    ).toThrow(/reserved for internal stream transport/);

    expect(() =>
      defineContract({
        methods: [] as const,
        events: [] as const,
        streamMethods: [streamRpc("stream/foo", S.Struct({}), S.Struct({}))] as const,
      }),
    ).toThrow(/must not start with "stream\/"/);
  });

  it("when method name is reserved, then defineContract throws", () => {
    expect(() =>
      defineContract({
        methods: [rpc("sf", S.Struct({}), S.Struct({}))] as const,
        events: [] as const,
      }),
    ).toThrow(/reserved for internal stream transport/);
  });

  it("when no streamMethods are provided, then contract has empty streamMethods", () => {
    const c = defineContract({
      methods: [Ping] as const,
      events: [] as const,
    });
    expect(c.streamMethods).toEqual([]);
  });
});

describe("parseStreamFrame", () => {
  it("when frame is a data frame, then it parses correctly", () => {
    const frame = parseStreamFrame({
      type: "data",
      streamId: "abc",
      payload: { value: 42 },
    });
    expect(frame).toEqual({
      type: "data",
      streamId: "abc",
      payload: { value: 42 },
    });
  });

  it("when frame is an end frame, then it parses correctly", () => {
    const frame = parseStreamFrame({ type: "end", streamId: "abc" });
    expect(frame).toEqual({ type: "end", streamId: "abc" });
  });

  it("when frame is an error frame, then it parses correctly", () => {
    const frame = parseStreamFrame({
      type: "error",
      streamId: "abc",
      error: {
        tag: "StreamError",
        data: { _tag: "StreamError", message: "boom" },
      },
    });
    expect(frame).toEqual({
      type: "error",
      streamId: "abc",
      error: {
        tag: "StreamError",
        data: { _tag: "StreamError", message: "boom" },
      },
    });
  });

  it("when frame is a defect frame, then it parses correctly", () => {
    const frame = parseStreamFrame({
      type: "defect",
      streamId: "abc",
      message: "something broke",
    });
    expect(frame).toEqual({
      type: "defect",
      streamId: "abc",
      message: "something broke",
    });
  });

  it("when frame is malformed, then it returns null", () => {
    expect(parseStreamFrame(null)).toBeNull();
    expect(parseStreamFrame(42)).toBeNull();
    expect(parseStreamFrame({})).toBeNull();
    expect(parseStreamFrame({ type: "data" })).toBeNull(); // missing streamId
    expect(parseStreamFrame({ type: "data", streamId: "a" })).toBeNull(); // missing payload
    expect(parseStreamFrame({ type: "error", streamId: "a", error: {} })).toBeNull(); // missing tag
  });
});

describe("createRpcEndpoint with streamHandlers", () => {
  it("when endpoint starts with stream handlers, then stream channels are registered", () => {
    const harness = createStreamHarness();

    const endpoint = createRpcEndpoint(
      contract,
      harness.ipcMain,
      {
        Ping: () => Effect.succeed({ ok: true }),
      },
      {
        runtime: Runtime.defaultRuntime,
        streamHandlers: {
          StreamAdd: ({ count }) =>
            Stream.fromIterable(Array.from({ length: count }, (_, i) => ({ value: i }))),
          StreamFail: () => Stream.fail(new StreamError({ message: "denied" })),
        },
      },
    );

    endpoint.start();
    expect(harness.handlers.has("rpc/stream/StreamAdd")).toBe(true);
    expect(harness.handlers.has("rpc/stream/StreamFail")).toBe(true);
    expect(harness.handlers.has("rpc/stream-cancel")).toBe(true);
    // Regular RPC still registered
    expect(harness.handlers.has("rpc/Ping")).toBe(true);
  });

  it("when endpoint stops, then stream channels are removed", () => {
    const harness = createStreamHarness();

    const endpoint = createRpcEndpoint(
      contract,
      harness.ipcMain,
      {
        Ping: () => Effect.succeed({ ok: true }),
      },
      {
        runtime: Runtime.defaultRuntime,
        streamHandlers: {
          StreamAdd: ({ count }) =>
            Stream.fromIterable(Array.from({ length: count }, (_, i) => ({ value: i }))),
          StreamFail: () => Stream.fail(new StreamError({ message: "denied" })),
        },
      },
    );

    endpoint.start();
    endpoint.stop();
    expect(harness.handlers.size).toBe(0);
  });

  it("when stream handler is invoked, then it returns stream_started and sends data frames", async () => {
    const harness = createStreamHarness();

    const endpoint = createRpcEndpoint(
      contract,
      harness.ipcMain,
      {
        Ping: () => Effect.succeed({ ok: true }),
      },
      {
        runtime: Runtime.defaultRuntime,
        streamHandlers: {
          StreamAdd: ({ count }) =>
            Stream.fromIterable(Array.from({ length: count }, (_, i) => ({ value: i }))),
          StreamFail: () => Stream.fail(new StreamError({ message: "denied" })),
        },
      },
    );

    endpoint.start();

    const response = await harness.invoke("stream/StreamAdd", {
      data: { count: 3 },
      streamId: "test-stream-1",
    });

    expect(response).toEqual({
      type: "success",
      data: { type: "stream_started" },
    });

    // Wait for frames to be sent
    await waitFor(() => {
      const endFrames = harness.sentFrames.filter((f) => {
        const frame = asFrame(f);
        return frame?.type === "end" && frame.streamId === "test-stream-1";
      });
      return endFrames.length > 0;
    });

    // Verify data frames
    const dataFrames = harness.sentFrames
      .filter((f) => {
        const frame = asFrame(f);
        return frame?.type === "data" && frame.streamId === "test-stream-1";
      })
      .map((f) => {
        const rec = isRecord(f.payload) ? f.payload : {};
        return rec.payload;
      });

    expect(dataFrames).toEqual([{ value: 0 }, { value: 1 }, { value: 2 }]);
  });

  it("when stream handler fails with typed error, then error frame is sent", async () => {
    const harness = createStreamHarness();

    const endpoint = createRpcEndpoint(
      contract,
      harness.ipcMain,
      {
        Ping: () => Effect.succeed({ ok: true }),
      },
      {
        runtime: Runtime.defaultRuntime,
        streamHandlers: {
          StreamAdd: ({ count }) =>
            Stream.fromIterable(Array.from({ length: count }, (_, i) => ({ value: i }))),
          StreamFail: () => Stream.fail(new StreamError({ message: "denied" })),
        },
      },
    );

    endpoint.start();

    await harness.invoke("stream/StreamFail", {
      data: {},
      streamId: "fail-stream-1",
    });

    await waitFor(() => {
      return harness.sentFrames.some((f) => {
        const frame = asFrame(f);
        return (
          (frame?.type === "error" || frame?.type === "defect") &&
          frame.streamId === "fail-stream-1"
        );
      });
    });

    const errorFrame = harness.sentFrames.find((f) => {
      const frame = asFrame(f);
      return frame?.type === "error" && frame.streamId === "fail-stream-1";
    });

    expect(errorFrame).toBeDefined();
    const frame = asFrame(errorFrame!);
    expect(frame).not.toBeNull();
    if (frame?.type === "error") {
      expect(frame.error.tag).toBe("StreamError");
    }
  });

  it("when stream request has invalid streamId, then defect envelope is returned", async () => {
    const harness = createStreamHarness();

    const endpoint = createRpcEndpoint(
      contract,
      harness.ipcMain,
      {
        Ping: () => Effect.succeed({ ok: true }),
      },
      {
        runtime: Runtime.defaultRuntime,
        streamHandlers: {
          StreamAdd: ({ count }) =>
            Stream.fromIterable(Array.from({ length: count }, (_, i) => ({ value: i }))),
          StreamFail: () => Stream.fail(new StreamError({ message: "denied" })),
        },
      },
    );

    endpoint.start();

    const response = await harness.invoke("stream/StreamAdd", {
      data: { count: 1 },
      streamId: "",
    });

    expect(response).toMatchObject({ type: "defect" });
  });

  it("when duplicate streamId is provided, then defect envelope is returned", async () => {
    const harness = createStreamHarness();

    const endpoint = createRpcEndpoint(
      contract,
      harness.ipcMain,
      {
        Ping: () => Effect.succeed({ ok: true }),
      },
      {
        runtime: Runtime.defaultRuntime,
        streamHandlers: {
          StreamAdd: () =>
            Stream.fromIterable(Array.from({ length: 100000 }, (_, i) => ({ value: i }))).pipe(
              Stream.tap(() => Effect.yieldNow()),
            ),
          StreamFail: () => Stream.fail(new StreamError({ message: "denied" })),
        },
      },
    );

    endpoint.start();

    // First invocation — starts a long-running stream
    const first = await harness.invoke("stream/StreamAdd", {
      data: { count: 1 },
      streamId: "dup-id",
    });
    expect(first).toEqual({
      type: "success",
      data: { type: "stream_started" },
    });

    // Second invocation with same streamId — should be rejected
    const second = await harness.invoke("stream/StreamAdd", {
      data: { count: 1 },
      streamId: "dup-id",
    });
    expect(second).toMatchObject({ type: "defect" });
    if (isRecord(second) && typeof second.message === "string") {
      expect(second.message).toContain("Duplicate");
    }

    endpoint.dispose();
  });

  it("when cancel is called on active stream, then cancel is accepted", async () => {
    const harness = createStreamHarness();

    const endpoint = createRpcEndpoint(
      contract,
      harness.ipcMain,
      {
        Ping: () => Effect.succeed({ ok: true }),
      },
      {
        runtime: Runtime.defaultRuntime,
        streamHandlers: {
          StreamAdd: () =>
            Stream.fromIterable(Array.from({ length: 100000 }, (_, i) => ({ value: i }))).pipe(
              Stream.tap(() => Effect.yieldNow()),
            ),
          StreamFail: () => Stream.fail(new StreamError({ message: "denied" })),
        },
      },
    );

    endpoint.start();

    // Start a stream that will take a while
    await harness.invoke("stream/StreamAdd", {
      data: { count: 999 },
      streamId: "cancel-me",
    });

    // Give the fiber time to start
    await new Promise((r) => setTimeout(r, 10));

    // Cancel it
    const cancelResult = await harness.invoke("stream-cancel", {
      streamId: "cancel-me",
    });

    expect(cancelResult).toMatchObject({ cancelled: true });

    // Give time for cleanup
    await new Promise((r) => setTimeout(r, 50));
  });

  it("when cancel is called for nonexistent stream, then cancelled is false", async () => {
    const harness = createStreamHarness();

    const endpoint = createRpcEndpoint(
      contract,
      harness.ipcMain,
      {
        Ping: () => Effect.succeed({ ok: true }),
      },
      {
        runtime: Runtime.defaultRuntime,
        streamHandlers: {
          StreamAdd: ({ count }) =>
            Stream.fromIterable(Array.from({ length: count }, (_, i) => ({ value: i }))),
          StreamFail: () => Stream.fail(new StreamError({ message: "denied" })),
        },
      },
    );

    endpoint.start();

    const cancelResult = await harness.invoke("stream-cancel", {
      streamId: "nonexistent",
    });

    expect(cancelResult).toMatchObject({ cancelled: false });
  });

  it("when input decode fails, then defect envelope is returned", async () => {
    const harness = createStreamHarness();

    const endpoint = createRpcEndpoint(
      contract,
      harness.ipcMain,
      {
        Ping: () => Effect.succeed({ ok: true }),
      },
      {
        runtime: Runtime.defaultRuntime,
        streamHandlers: {
          StreamAdd: ({ count }) =>
            Stream.fromIterable(Array.from({ length: count }, (_, i) => ({ value: i }))),
          StreamFail: () => Stream.fail(new StreamError({ message: "denied" })),
        },
      },
    );

    endpoint.start();

    // Send invalid data (count is required Number)
    const response = await harness.invoke("stream/StreamAdd", {
      data: { count: "not-a-number" },
      streamId: "bad-input",
    });

    expect(response).toMatchObject({
      type: "defect",
    });
  });
});

describe("stream rpc end-to-end", () => {
  it("when stream client consumes a finite stream, then all chunks are received", async () => {
    const harness = createStreamHarness();

    const endpoint = createRpcEndpoint(
      contract,
      harness.ipcMain,
      {
        Ping: () => Effect.succeed({ ok: true }),
      },
      {
        runtime: Runtime.defaultRuntime,
        streamHandlers: {
          StreamAdd: ({ count }) =>
            Stream.fromIterable(Array.from({ length: count }, (_, i) => ({ value: i }))),
          StreamFail: () => Stream.fail(new StreamError({ message: "denied" })),
        },
      },
    );

    endpoint.start();

    const streamHandle = createStreamRpcClient(contract, {
      invoke: harness.invoke,
      onStreamFrame: harness.onStreamFrame,
    });

    const chunks: Array<{ value: number }> = [];

    await Effect.runPromise(
      streamHandle.client.StreamAdd({ count: 5 }).pipe(
        Stream.runForEach((chunk) =>
          Effect.sync(() => {
            chunks.push(chunk);
          }),
        ),
      ),
    );

    expect(chunks).toEqual([{ value: 0 }, { value: 1 }, { value: 2 }, { value: 3 }, { value: 4 }]);

    streamHandle.dispose();
    endpoint.stop();
  });

  it("when stream handler emits typed error, then client receives it", async () => {
    const harness = createStreamHarness();

    const endpoint = createRpcEndpoint(
      contract,
      harness.ipcMain,
      {
        Ping: () => Effect.succeed({ ok: true }),
      },
      {
        runtime: Runtime.defaultRuntime,
        streamHandlers: {
          StreamAdd: ({ count }) =>
            Stream.fromIterable(Array.from({ length: count }, (_, i) => ({ value: i }))),
          StreamFail: () => Stream.fail(new StreamError({ message: "denied" })),
        },
      },
    );

    endpoint.start();

    const streamHandle = createStreamRpcClient(contract, {
      invoke: harness.invoke,
      onStreamFrame: harness.onStreamFrame,
    });

    const result = await Effect.runPromiseExit(
      streamHandle.client.StreamFail({}).pipe(Stream.runDrain),
    );

    expect(result._tag).toBe("Failure");

    streamHandle.dispose();
    endpoint.stop();
  });

  it("when client takes limited chunks, then stream is cancelled cleanly", async () => {
    const harness = createStreamHarness();

    const endpoint = createRpcEndpoint(
      contract,
      harness.ipcMain,
      {
        Ping: () => Effect.succeed({ ok: true }),
      },
      {
        runtime: Runtime.defaultRuntime,
        streamHandlers: {
          StreamAdd: ({ count }) =>
            Stream.fromIterable(Array.from({ length: count }, (_, i) => ({ value: i }))),
          StreamFail: () => Stream.fail(new StreamError({ message: "denied" })),
        },
      },
    );

    endpoint.start();

    const streamHandle = createStreamRpcClient(contract, {
      invoke: harness.invoke,
      onStreamFrame: harness.onStreamFrame,
    });

    const chunks: Array<{ value: number }> = [];

    await Effect.runPromise(
      streamHandle.client.StreamAdd({ count: 100 }).pipe(
        Stream.take(3),
        Stream.runForEach((chunk) =>
          Effect.sync(() => {
            chunks.push(chunk);
          }),
        ),
      ),
    );

    expect(chunks).toEqual([{ value: 0 }, { value: 1 }, { value: 2 }]);

    streamHandle.dispose();
    endpoint.stop();
  });

  it("when multiple streams run concurrently, then each receives its own data", async () => {
    const harness = createStreamHarness();

    const endpoint = createRpcEndpoint(
      contract,
      harness.ipcMain,
      {
        Ping: () => Effect.succeed({ ok: true }),
      },
      {
        runtime: Runtime.defaultRuntime,
        streamHandlers: {
          StreamAdd: ({ count }) =>
            Stream.fromIterable(Array.from({ length: count }, (_, i) => ({ value: i }))),
          StreamFail: () => Stream.fail(new StreamError({ message: "denied" })),
        },
      },
    );

    endpoint.start();

    const streamHandle = createStreamRpcClient(contract, {
      invoke: harness.invoke,
      onStreamFrame: harness.onStreamFrame,
    });

    const [chunks3, chunks2] = await Effect.runPromise(
      Effect.all([
        streamHandle.client.StreamAdd({ count: 3 }).pipe(
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
        ),
        streamHandle.client.StreamAdd({ count: 2 }).pipe(
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
        ),
      ]),
    );

    expect(chunks3).toEqual([{ value: 0 }, { value: 1 }, { value: 2 }]);
    expect(chunks2).toEqual([{ value: 0 }, { value: 1 }]);

    streamHandle.dispose();
    endpoint.stop();
  });

  it("when endpoint is disposed during active stream, then stream terminates", async () => {
    const harness = createStreamHarness();

    const endpoint = createRpcEndpoint(
      contract,
      harness.ipcMain,
      {
        Ping: () => Effect.succeed({ ok: true }),
      },
      {
        runtime: Runtime.defaultRuntime,
        streamHandlers: {
          StreamAdd: () =>
            Stream.fromEffect(
              Effect.sleep("500 millis").pipe(Effect.map(() => ({ value: 1 }))),
            ).pipe(Stream.forever),
          StreamFail: () => Stream.fail(new StreamError({ message: "denied" })),
        },
      },
    );

    endpoint.start();

    // Start a long-running stream
    await harness.invoke("stream/StreamAdd", {
      data: { count: 999 },
      streamId: "dispose-me",
    });

    // Dispose the endpoint
    endpoint.dispose();

    // All handlers should be removed
    expect(harness.handlers.size).toBe(0);
  });

  it("when stream handler receives request without sender, then defect is returned", async () => {
    const harness = createStreamHarness();

    const endpoint = createRpcEndpoint(
      contract,
      harness.ipcMain,
      {
        Ping: () => Effect.succeed({ ok: true }),
      },
      {
        runtime: Runtime.defaultRuntime,
        streamHandlers: {
          StreamAdd: ({ count }) =>
            Stream.fromIterable(Array.from({ length: count }, (_, i) => ({ value: i }))),
          StreamFail: () => Stream.fail(new StreamError({ message: "denied" })),
        },
      },
    );

    endpoint.start();

    // Call handler directly with empty event (no sender)
    const handler = harness.handlers.get("rpc/stream/StreamAdd")!;
    const response = await handler(
      {},
      {
        data: { count: 1 },
        streamId: "no-sender",
      },
    );

    expect(response).toMatchObject({ type: "defect" });
  });

  it("when regular RPC methods work alongside stream methods, then both function correctly", async () => {
    const harness = createStreamHarness();

    const endpoint = createRpcEndpoint(
      contract,
      harness.ipcMain,
      {
        Ping: () => Effect.succeed({ ok: true }),
      },
      {
        runtime: Runtime.defaultRuntime,
        streamHandlers: {
          StreamAdd: ({ count }) =>
            Stream.fromIterable(Array.from({ length: count }, (_, i) => ({ value: i }))),
          StreamFail: () => Stream.fail(new StreamError({ message: "denied" })),
        },
      },
    );

    endpoint.start();

    // Test regular RPC still works
    const pingHandler = harness.handlers.get("rpc/Ping")!;
    const pingResponse = await pingHandler({}, {});
    expect(pingResponse).toEqual({ type: "success", data: { ok: true } });

    // Test stream works
    const streamHandle = createStreamRpcClient(contract, {
      invoke: harness.invoke,
      onStreamFrame: harness.onStreamFrame,
    });

    const chunks: Array<{ value: number }> = [];
    await Effect.runPromise(
      streamHandle.client.StreamAdd({ count: 2 }).pipe(
        Stream.runForEach((chunk) =>
          Effect.sync(() => {
            chunks.push(chunk);
          }),
        ),
      ),
    );

    expect(chunks).toEqual([{ value: 0 }, { value: 1 }]);

    streamHandle.dispose();
    endpoint.stop();
  });
});

// Main-side stream edge cases

describe("main-side stream edge cases", () => {
  it("when sender is destroyed mid-stream, then no further frames are sent", async () => {
    const harness = createStreamHarness();

    const endpoint = createRpcEndpoint(
      contract,
      harness.ipcMain,
      {
        Ping: () => Effect.succeed({ ok: true }),
      },
      {
        runtime: Runtime.defaultRuntime,
        streamHandlers: {
          StreamAdd: ({ count }) =>
            Stream.fromIterable(Array.from({ length: count }, (_, i) => ({ value: i }))).pipe(
              Stream.tap(() => Effect.sleep("5 millis")),
            ),
          StreamFail: () => Stream.fail(new StreamError({ message: "denied" })),
        },
      },
    );

    endpoint.start();

    await harness.invoke("stream/StreamAdd", {
      data: { count: 50 },
      streamId: "destroy-me",
    });

    // Wait for at least one data frame
    await waitFor(() =>
      harness.sentFrames.some((f) => {
        const frame = asFrame(f);
        return frame?.type === "data" && frame.streamId === "destroy-me";
      }),
    );

    harness.setSenderDestroyed(true);

    // Let any in-flight frame settle
    await new Promise((r) => setTimeout(r, 50));
    const frameCountAfterSettled = harness.sentFrames.length;

    // Wait for the stream to finish processing remaining chunks
    await new Promise((r) => setTimeout(r, 500));

    // No new frames should have been sent after sender was destroyed
    expect(harness.sentFrames.length).toBe(frameCountAfterSettled);

    // No end frame should be sent either
    const endFrames = harness.sentFrames.filter((f) => {
      const frame = asFrame(f);
      return frame?.type === "end" && frame.streamId === "destroy-me";
    });
    expect(endFrames.length).toBe(0);

    endpoint.dispose();
  });

  it("when cancel is called from a different sender, then cancel is rejected", async () => {
    const harness = createStreamHarness();

    const endpoint = createRpcEndpoint(
      contract,
      harness.ipcMain,
      {
        Ping: () => Effect.succeed({ ok: true }),
      },
      {
        runtime: Runtime.defaultRuntime,
        streamHandlers: {
          StreamAdd: () =>
            Stream.fromIterable(Array.from({ length: 100000 }, (_, i) => ({ value: i }))).pipe(
              Stream.tap(() => Effect.yieldNow()),
            ),
          StreamFail: () => Stream.fail(new StreamError({ message: "denied" })),
        },
      },
    );

    endpoint.start();

    await harness.invoke("stream/StreamAdd", {
      data: { count: 999 },
      streamId: "auth-test",
    });

    await new Promise((r) => setTimeout(r, 10));

    // Call cancel handler directly with a different sender id
    const cancelHandler = harness.handlers.get("rpc/stream-cancel")!;
    const differentSender = {
      sender: { id: 999, isDestroyed: () => false, send: () => {} },
    };
    const result = await cancelHandler(differentSender, {
      streamId: "auth-test",
    });
    expect(result).toMatchObject({ cancelled: false });

    // Original sender should still work
    const result2 = await cancelHandler(harness.mockEvent, {
      streamId: "auth-test",
    });
    expect(result2).toMatchObject({ cancelled: true });

    endpoint.dispose();
  });

  it("when cancel is called without sender, then cancel is rejected", async () => {
    const harness = createStreamHarness();

    const endpoint = createRpcEndpoint(
      contract,
      harness.ipcMain,
      {
        Ping: () => Effect.succeed({ ok: true }),
      },
      {
        runtime: Runtime.defaultRuntime,
        streamHandlers: {
          StreamAdd: () =>
            Stream.fromIterable(Array.from({ length: 100000 }, (_, i) => ({ value: i }))).pipe(
              Stream.tap(() => Effect.yieldNow()),
            ),
          StreamFail: () => Stream.fail(new StreamError({ message: "denied" })),
        },
      },
    );

    endpoint.start();

    await harness.invoke("stream/StreamAdd", {
      data: { count: 999 },
      streamId: "no-sender-cancel",
    });

    await new Promise((r) => setTimeout(r, 10));

    const cancelHandler = harness.handlers.get("rpc/stream-cancel")!;
    const result = await cancelHandler({}, { streamId: "no-sender-cancel" });
    expect(result).toMatchObject({ cancelled: false });

    endpoint.dispose();
  });

  it("when stream handler dies, then defect frame is sent", async () => {
    const harness = createStreamHarness();

    const endpoint = createRpcEndpoint(
      contract,
      harness.ipcMain,
      {
        Ping: () => Effect.succeed({ ok: true }),
      },
      {
        runtime: Runtime.defaultRuntime,
        streamHandlers: {
          // @ts-expect-error intentionally wrong stream return type to test defect handling
          StreamAdd: () => Stream.fromEffect(Effect.die("handler crashed")),
          StreamFail: () => Stream.fail(new StreamError({ message: "denied" })),
        },
      },
    );

    endpoint.start();

    await harness.invoke("stream/StreamAdd", {
      data: { count: 1 },
      streamId: "die-test",
    });

    await waitFor(() =>
      harness.sentFrames.some((f) => {
        const frame = asFrame(f);
        return frame?.type === "defect" && frame.streamId === "die-test";
      }),
    );

    const defectFrame = harness.sentFrames.find((f) => {
      const frame = asFrame(f);
      return frame?.type === "defect" && frame.streamId === "die-test";
    });

    expect(defectFrame).toBeDefined();
    const parsed = asFrame(defectFrame!);
    expect(parsed).not.toBeNull();
    if (parsed?.type === "defect") {
      expect(parsed.message).toContain("handler crashed");
    }

    endpoint.dispose();
  });

  it("when error encoding fails, then defect frame is sent as fallback", async () => {
    const harness = createStreamHarness();

    const endpoint = createRpcEndpoint(
      contract,
      harness.ipcMain,
      {
        Ping: () => Effect.succeed({ ok: true }),
      },
      {
        runtime: Runtime.defaultRuntime,
        streamHandlers: {
          StreamAdd: ({ count }) =>
            Stream.fromIterable(Array.from({ length: count }, (_, i) => ({ value: i }))),
          // @ts-expect-error Fail with a value that doesn't match the StreamError schema
          StreamFail: () => Stream.fail(42),
        },
      },
    );

    endpoint.start();

    await harness.invoke("stream/StreamFail", {
      data: {},
      streamId: "encode-fail",
    });

    await waitFor(() =>
      harness.sentFrames.some((f) => {
        const frame = asFrame(f);
        return (
          (frame?.type === "defect" || frame?.type === "error") && frame.streamId === "encode-fail"
        );
      }),
    );

    // Should be a defect (not error) because encoding the error value failed
    const defectFrame = harness.sentFrames.find((f) => {
      const frame = asFrame(f);
      return frame?.type === "defect" && frame.streamId === "encode-fail";
    });
    expect(defectFrame).toBeDefined();

    endpoint.dispose();
  });

  it("when stream is cancelled, then no error or defect frame is sent and cleanup happens", async () => {
    const harness = createStreamHarness();

    const endpoint = createRpcEndpoint(
      contract,
      harness.ipcMain,
      {
        Ping: () => Effect.succeed({ ok: true }),
      },
      {
        runtime: Runtime.defaultRuntime,
        streamHandlers: {
          StreamAdd: () =>
            Stream.repeatEffect(Effect.sleep("10 millis").pipe(Effect.as({ value: 1 }))),
          StreamFail: () => Stream.fail(new StreamError({ message: "denied" })),
        },
      },
    );

    endpoint.start();

    await harness.invoke("stream/StreamAdd", {
      data: { count: 999 },
      streamId: "cancel-frame-test",
    });

    // Wait for stream to start producing
    await waitFor(() =>
      harness.sentFrames.some((f) => {
        const frame = asFrame(f);
        return frame?.type === "data" && frame.streamId === "cancel-frame-test";
      }),
    );

    await harness.invoke("stream-cancel", { streamId: "cancel-frame-test" });

    // Wait for interrupt processing and cleanup
    await new Promise((r) => setTimeout(r, 500));

    // Cancellation should NOT produce error or defect frames
    const errorDefectFrames = harness.sentFrames.filter((f) => {
      const frame = asFrame(f);
      return (
        (frame?.type === "error" || frame?.type === "defect") &&
        frame.streamId === "cancel-frame-test"
      );
    });
    expect(errorDefectFrames.length).toBe(0);

    // Verify cleanup happened (entry removed from activeStreams)
    const cancelHandler = harness.handlers.get("rpc/stream-cancel")!;
    const secondCancel = await cancelHandler(harness.mockEvent, {
      streamId: "cancel-frame-test",
    });
    expect(secondCancel).toMatchObject({ cancelled: false });

    endpoint.dispose();
  });

  it("when NoError stream handler fails, then defect frame is sent", async () => {
    const harness = createStreamHarness();

    const endpoint = createRpcEndpoint(
      contract,
      harness.ipcMain,
      {
        Ping: () => Effect.succeed({ ok: true }),
      },
      {
        runtime: Runtime.defaultRuntime,
        streamHandlers: {
          // @ts-expect-error StreamAdd is NoError, but we force a failure
          StreamAdd: () => Stream.fail(new Error("unexpected failure")),
          StreamFail: () => Stream.fail(new StreamError({ message: "denied" })),
        },
      },
    );

    endpoint.start();

    await harness.invoke("stream/StreamAdd", {
      data: { count: 1 },
      streamId: "noerror-fail",
    });

    await waitFor(() =>
      harness.sentFrames.some((f) => {
        const frame = asFrame(f);
        return frame?.type === "defect" && frame.streamId === "noerror-fail";
      }),
    );

    const defectFrame = harness.sentFrames.find((f) => {
      const frame = asFrame(f);
      return frame?.type === "defect" && frame.streamId === "noerror-fail";
    });
    expect(defectFrame).toBeDefined();
    const parsed = asFrame(defectFrame!);
    expect(parsed).not.toBeNull();
    if (parsed?.type === "defect") {
      expect(parsed.message).toContain("unexpected failure");
    }

    endpoint.dispose();
  });

  it("when stream-request decode fails, then diagnostics onDecodeFailure is called", async () => {
    const harness = createStreamHarness();
    const decodeFailures: Array<{ scope: string; name: string }> = [];

    const endpoint = createRpcEndpoint(
      contract,
      harness.ipcMain,
      {
        Ping: () => Effect.succeed({ ok: true }),
      },
      {
        runtime: Runtime.defaultRuntime,
        diagnostics: {
          onDecodeFailure: (ctx) => {
            decodeFailures.push({ scope: ctx.scope, name: ctx.name });
          },
        },
        streamHandlers: {
          StreamAdd: ({ count }) =>
            Stream.fromIterable(Array.from({ length: count }, (_, i) => ({ value: i }))),
          StreamFail: () => Stream.fail(new StreamError({ message: "denied" })),
        },
      },
    );

    endpoint.start();

    await harness.invoke("stream/StreamAdd", {
      data: { count: "bad" },
      streamId: "diag-test",
    });

    expect(decodeFailures).toContainEqual({
      scope: "stream-request",
      name: "StreamAdd",
    });

    endpoint.dispose();
  });
});

// Renderer-side stream edge cases

describe("renderer-side stream edge cases", () => {
  it("when malformed frame has valid streamId, then active stream fails with defect", async () => {
    const harness = createStreamHarness();

    const endpoint = createRpcEndpoint(
      contract,
      harness.ipcMain,
      {
        Ping: () => Effect.succeed({ ok: true }),
      },
      {
        runtime: Runtime.defaultRuntime,
        streamHandlers: {
          StreamAdd: ({ count }) =>
            Stream.fromIterable(Array.from({ length: count }, (_, i) => ({ value: i }))).pipe(
              Stream.tap(() => Effect.sleep("20 millis")),
            ),
          StreamFail: () => Stream.fail(new StreamError({ message: "denied" })),
        },
      },
    );

    endpoint.start();

    const streamHandle = createStreamRpcClient(contract, {
      invoke: harness.invoke,
      onStreamFrame: harness.onStreamFrame,
    });

    const exitPromise = Effect.runPromiseExit(
      streamHandle.client.StreamAdd({ count: 50 }).pipe(Stream.runDrain),
    );

    // Wait for at least one data frame to extract the streamId
    await waitFor(() =>
      harness.sentFrames.some((f) => {
        const frame = asFrame(f);
        return frame?.type === "data";
      }),
    );

    const dataFrame = harness.sentFrames.find((f) => {
      const frame = asFrame(f);
      return frame?.type === "data";
    });
    const streamId = extractStreamId(dataFrame!.payload);

    // Inject a malformed frame with valid streamId but invalid type
    for (const listener of harness.frameListeners) {
      listener({ streamId, type: "bogus-type" });
    }

    const exit = await exitPromise;
    expect(exit._tag).toBe("Failure");

    if (exit._tag === "Failure") {
      const error = Cause.failureOption(exit.cause);
      expect(error._tag).toBe("Some");
      if (error._tag === "Some") {
        const defect = asRpcDefect(error.value);
        expect(defect.message).toContain("Malformed stream frame received");
      }
    }

    streamHandle.dispose();
    endpoint.dispose();
  });

  it("when stream client is disposed during active stream, then consumer fails with defect", async () => {
    const harness = createStreamHarness();

    const endpoint = createRpcEndpoint(
      contract,
      harness.ipcMain,
      {
        Ping: () => Effect.succeed({ ok: true }),
      },
      {
        runtime: Runtime.defaultRuntime,
        streamHandlers: {
          StreamAdd: () =>
            Stream.fromEffect(
              Effect.sleep("50 millis").pipe(Effect.map(() => ({ value: 1 }))),
            ).pipe(Stream.forever),
          StreamFail: () => Stream.fail(new StreamError({ message: "denied" })),
        },
      },
    );

    endpoint.start();

    const streamHandle = createStreamRpcClient(contract, {
      invoke: harness.invoke,
      onStreamFrame: harness.onStreamFrame,
    });

    const exitPromise = Effect.runPromiseExit(
      streamHandle.client.StreamAdd({ count: 1 }).pipe(Stream.runDrain),
    );

    // Wait for stream to start producing
    await waitFor(() => harness.sentFrames.length > 0);

    // Dispose the client while stream is active
    streamHandle.dispose();

    const exit = await exitPromise;
    expect(exit._tag).toBe("Failure");

    if (exit._tag === "Failure") {
      const error = Cause.failureOption(exit.cause);
      expect(error._tag).toBe("Some");
      if (error._tag === "Some") {
        const defect = asRpcDefect(error.value);
        expect(defect.message).toContain("Stream client disposed");
      }
    }

    endpoint.dispose();
  });

  it("when handshake returns unexpected response, then stream fails with stream_handshake_invalid", async () => {
    const harness = createStreamHarness();

    const mockInvoke = async (method: string, _payload: unknown) => {
      if (method.startsWith("stream/")) {
        return { type: "success", data: { unexpected: true } };
      }
      return { cancelled: false };
    };

    const streamHandle = createStreamRpcClient(contract, {
      invoke: mockInvoke,
      onStreamFrame: harness.onStreamFrame,
    });

    const exit = await Effect.runPromiseExit(
      streamHandle.client.StreamAdd({ count: 1 }).pipe(Stream.runDrain),
    );

    expect(exit._tag).toBe("Failure");

    if (exit._tag === "Failure") {
      const error = Cause.failureOption(exit.cause);
      expect(error._tag).toBe("Some");
      if (error._tag === "Some") {
        const defect = asRpcDefect(error.value);
        expect(defect.code).toBe("stream_handshake_invalid");
      }
    }

    streamHandle.dispose();
  });

  it("when NoError stream receives error frame, then client fails with stream_error_decode_failed", async () => {
    const harness = createStreamHarness();

    const endpoint = createRpcEndpoint(
      contract,
      harness.ipcMain,
      {
        Ping: () => Effect.succeed({ ok: true }),
      },
      {
        runtime: Runtime.defaultRuntime,
        streamHandlers: {
          StreamAdd: ({ count }) =>
            Stream.fromIterable(Array.from({ length: count }, (_, i) => ({ value: i }))).pipe(
              Stream.tap(() => Effect.sleep("20 millis")),
            ),
          StreamFail: () => Stream.fail(new StreamError({ message: "denied" })),
        },
      },
    );

    endpoint.start();

    const streamHandle = createStreamRpcClient(contract, {
      invoke: harness.invoke,
      onStreamFrame: harness.onStreamFrame,
    });

    const exitPromise = Effect.runPromiseExit(
      streamHandle.client.StreamAdd({ count: 50 }).pipe(Stream.runDrain),
    );

    // Wait for at least one data frame to get streamId
    await waitFor(() =>
      harness.sentFrames.some((f) => {
        const frame = asFrame(f);
        return frame?.type === "data";
      }),
    );

    const dataFrame = harness.sentFrames.find((f) => {
      const frame = asFrame(f);
      return frame?.type === "data";
    });
    const streamId = extractStreamId(dataFrame!.payload);

    // Inject an error frame for a NoError stream method
    for (const listener of harness.frameListeners) {
      listener({
        type: "error",
        streamId,
        error: { tag: "SomeError", data: {} },
      });
    }

    const exit = await exitPromise;
    expect(exit._tag).toBe("Failure");

    if (exit._tag === "Failure") {
      const error = Cause.failureOption(exit.cause);
      expect(error._tag).toBe("Some");
      if (error._tag === "Some") {
        const defect = asRpcDefect(error.value);
        expect(defect.code).toBe("stream_error_decode_failed");
      }
    }

    streamHandle.dispose();
    endpoint.dispose();
  });

  it("when malformed frame arrives, then onProtocolError diagnostics is invoked", () => {
    const harness = createStreamHarness();
    const protocolErrors: unknown[] = [];

    const streamHandle = createStreamRpcClient(contract, {
      invoke: async () => ({}),
      onStreamFrame: harness.onStreamFrame,
      diagnostics: {
        onProtocolError: (ctx) => {
          protocolErrors.push(ctx);
        },
      },
    });

    // Emit a completely malformed frame (no streamId)
    for (const listener of harness.frameListeners) {
      listener({ garbage: true });
    }

    expect(protocolErrors.length).toBe(1);
    expect(protocolErrors[0]).toMatchObject({
      method: "stream-frame",
    });

    streamHandle.dispose();
  });

  it("when default stream buffer is used, then slow consumers receive all chunks", async () => {
    const totalFrames = 120;
    const bridge = createScheduledFrameBridge({
      totalFrames,
      framesPerTick: 1,
    });

    const streamHandle = createStreamRpcClient(contract, {
      invoke: bridge.invoke,
      onStreamFrame: bridge.onStreamFrame,
    });

    const seen: number[] = [];

    await Promise.race([
      Effect.runPromise(
        streamHandle.client.StreamAdd({ count: 1 }).pipe(
          Stream.runForEach((chunk) =>
            Effect.sleep("1 millis").pipe(
              Effect.andThen(
                Effect.sync(() => {
                  seen.push(chunk.value);
                }),
              ),
            ),
          ),
        ),
      ),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Timed out waiting for stream completion")), 5000),
      ),
    ]);

    expect(seen).toEqual(Array.from({ length: totalFrames }, (_, i) => i));

    streamHandle.dispose();
  });

  it("when streamBuffer is omitted or explicitly unbounded, then behavior is equivalent", async () => {
    const totalFrames = 80;
    const expected = Array.from({ length: totalFrames }, (_, i) => i);

    const defaultBridge = createScheduledFrameBridge({ totalFrames });
    const explicitBridge = createScheduledFrameBridge({ totalFrames });

    const defaultHandle = createStreamRpcClient(contract, {
      invoke: defaultBridge.invoke,
      onStreamFrame: defaultBridge.onStreamFrame,
    });
    const explicitHandle = createStreamRpcClient(contract, {
      invoke: explicitBridge.invoke,
      onStreamFrame: explicitBridge.onStreamFrame,
      streamBuffer: { bufferSize: "unbounded" },
    });

    const collectValues = (handle: typeof defaultHandle) =>
      Effect.runPromise(
        handle.client.StreamAdd({ count: 1 }).pipe(
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk, (item) => item.value)),
        ),
      );

    const [defaultValues, explicitValues] = await Promise.all([
      collectValues(defaultHandle),
      collectValues(explicitHandle),
    ]);

    expect(defaultValues).toEqual(expected);
    expect(explicitValues).toEqual(expected);
    expect(explicitValues).toEqual(defaultValues);

    defaultHandle.dispose();
    explicitHandle.dispose();
  });

  it("when post-close data frames keep arriving, then post-close protocol diagnostics are emitted once", async () => {
    const bridge = createScheduledFrameBridge({
      totalFrames: 0,
    });
    const protocolErrors: unknown[] = [];
    let activeStreamId = "";

    const streamHandle = createStreamRpcClient(contract, {
      invoke: async (method, payload) => {
        if (method === "stream-cancel") {
          return { cancelled: true };
        }
        if (method.startsWith("stream/")) {
          if (!isRecord(payload) || typeof payload.streamId !== "string") {
            throw new Error("Missing streamId");
          }
          activeStreamId = payload.streamId;
          return { type: "success", data: { type: "stream_started" } };
        }
        return { type: "success", data: {} };
      },
      onStreamFrame: bridge.onStreamFrame,
      diagnostics: {
        onProtocolError: (ctx) => {
          protocolErrors.push(ctx);
        },
      },
    });

    const exitPromise = Effect.runPromiseExit(
      streamHandle.client.StreamAdd({ count: 1 }).pipe(Stream.runDrain),
    );

    await waitFor(() => activeStreamId.length > 0);

    bridge.emitFrame({
      type: "data",
      streamId: activeStreamId,
      payload: { value: "bad" },
    });
    bridge.emitFrame({
      type: "data",
      streamId: activeStreamId,
      payload: { value: 1 },
    });
    bridge.emitFrame({
      type: "data",
      streamId: activeStreamId,
      payload: { value: 2 },
    });
    bridge.emitFrame({
      type: "data",
      streamId: activeStreamId,
      payload: { value: 3 },
    });

    const exit = await exitPromise;
    expect(exit._tag).toBe("Failure");

    const postCloseProtocolErrors = protocolErrors.filter(
      (ctx) =>
        isRecord(ctx) &&
        isRecord(ctx.cause) &&
        typeof ctx.cause.message === "string" &&
        ctx.cause.message.includes("post-close"),
    );

    expect(postCloseProtocolErrors).toHaveLength(1);

    streamHandle.dispose();
  });

  it("when sliding strategy is configured, then bounded stream remains consumable and cancellable", async () => {
    const bridge = createScheduledFrameBridge({
      totalFrames: 100_000,
      framesPerTick: 8,
    });

    const handle = createStreamRpcClient(contract, {
      invoke: bridge.invoke,
      onStreamFrame: bridge.onStreamFrame,
      streamBuffer: {
        bufferSize: 4,
        strategy: "sliding",
      },
    });

    const seen: number[] = [];
    await Effect.runPromise(
      handle.client.StreamAdd({ count: 1 }).pipe(
        Stream.take(12),
        Stream.runForEach((chunk) =>
          Effect.sleep("10 millis").pipe(
            Effect.andThen(
              Effect.sync(() => {
                seen.push(chunk.value);
              }),
            ),
          ),
        ),
      ),
    );

    expect(seen).toHaveLength(12);
    expect(bridge.cancelCalls.length).toBeGreaterThan(0);

    handle.dispose();
  });

  it("when bounded stream is disposed while active, then stream fails and cancellation is requested", async () => {
    const bridge = createScheduledFrameBridge({
      totalFrames: 10_000,
      framesPerTick: 8,
    });

    const streamHandle = createStreamRpcClient(contract, {
      invoke: bridge.invoke,
      onStreamFrame: bridge.onStreamFrame,
      streamBuffer: {
        bufferSize: 4,
        strategy: "dropping",
      },
    });

    const exitPromise = Effect.runPromiseExit(
      streamHandle.client.StreamAdd({ count: 1 }).pipe(
        Stream.runForEach((chunk) =>
          Effect.sleep("10 millis").pipe(
            Effect.andThen(
              Effect.sync(() => {
                void chunk;
              }),
            ),
          ),
        ),
      ),
    );

    await waitFor(() => bridge.startedStreamIds.length === 1);
    streamHandle.dispose();

    const exit = await exitPromise;
    expect(exit._tag).toBe("Failure");
    expect(bridge.cancelCalls).toHaveLength(1);
  });
});

// Stream e2e edge cases

describe("stream rpc e2e edge cases", () => {
  it("when handshake returns defect envelope, then client fails with remote_defect", async () => {
    const harness = createStreamHarness();

    // Mock invoke that returns a defect envelope for stream handshake
    const mockInvoke = async (method: string, _payload: unknown) => {
      if (method.startsWith("stream/")) {
        return {
          type: "defect",
          message: "Stream StreamAdd request decode failed: count must be a number",
          cause: "bad input",
        };
      }
      return { cancelled: false };
    };

    const streamHandle = createStreamRpcClient(contract, {
      invoke: mockInvoke,
      onStreamFrame: harness.onStreamFrame,
    });

    const exit = await Effect.runPromiseExit(
      streamHandle.client.StreamAdd({ count: 1 }).pipe(Stream.runDrain),
    );

    expect(exit._tag).toBe("Failure");

    if (exit._tag === "Failure") {
      const error = Cause.failureOption(exit.cause);
      expect(error._tag).toBe("Some");
      if (error._tag === "Some") {
        const defect = asRpcDefect(error.value);
        expect(defect.code).toBe("remote_defect");
        expect(defect.message).toContain("decode failed");
      }
    }

    streamHandle.dispose();
  });

  it("when consumer interrupts via Stream.take, then cancel is sent to main", async () => {
    const harness = createStreamHarness();

    const endpoint = createRpcEndpoint(
      contract,
      harness.ipcMain,
      {
        Ping: () => Effect.succeed({ ok: true }),
      },
      {
        runtime: Runtime.defaultRuntime,
        streamHandlers: {
          StreamAdd: () =>
            Stream.repeatEffect(Effect.sleep("10 millis").pipe(Effect.as({ value: 1 }))),
          StreamFail: () => Stream.fail(new StreamError({ message: "denied" })),
        },
      },
    );

    endpoint.start();

    const streamHandle = createStreamRpcClient(contract, {
      invoke: harness.invoke,
      onStreamFrame: harness.onStreamFrame,
    });

    const chunks: Array<{ value: number }> = [];

    await Effect.runPromise(
      streamHandle.client.StreamAdd({ count: 1 }).pipe(
        Stream.take(2),
        Stream.runForEach((chunk) =>
          Effect.sync(() => {
            chunks.push(chunk);
          }),
        ),
      ),
    );

    expect(chunks).toHaveLength(2);

    // Wait for finalizer to send cancel and main fiber to process the interrupt
    await new Promise((r) => setTimeout(r, 500));

    // Find the streamId from data frames
    const dataFrame = harness.sentFrames.find((f) => {
      const frame = asFrame(f);
      return frame?.type === "data";
    });
    const streamId = extractStreamId(dataFrame!.payload);

    // Verify the main fiber was cleaned up (entry removed from activeStreams)
    // If cancel was NOT sent, the fiber would still be running
    const cancelHandler = harness.handlers.get("rpc/stream-cancel")!;
    const cancelResult = await cancelHandler(harness.mockEvent, { streamId });
    expect(cancelResult).toMatchObject({ cancelled: false });

    streamHandle.dispose();
    endpoint.stop();
  });
});

// Kit stream wiring

describe("kit stream wiring", () => {
  it("when contract has stream methods but bridge lacks onStreamFrame, then renderer throws", () => {
    const kit = createIpcKit({ contract });

    const bridgeWithoutStream = {
      invoke: async () => ({}),
      subscribe: () => () => {},
    };

    expect(() => kit.renderer(bridgeWithoutStream)).toThrow(/bridge.onStreamFrame is missing/);
  });

  it("when kit stream buffer is configured, then renderer stream client uses that policy", async () => {
    const totalFrames = 320;
    const bridge = createScheduledFrameBridge({
      totalFrames,
      framesPerTick: 8,
    });

    const kit = createIpcKit({
      contract,
      streamBuffer: {
        bufferSize: 4,
        strategy: "dropping",
      },
    });
    expect(kit.config.streamBuffer).toEqual({
      bufferSize: 4,
      strategy: "dropping",
    });

    const renderer = kit.renderer({
      invoke: bridge.invoke,
      subscribe: () => () => {},
      onStreamFrame: bridge.onStreamFrame,
    });

    const seen: number[] = [];

    await Effect.runPromise(
      renderer.streamClient.StreamAdd({ count: 1 }).pipe(
        Stream.take(12),
        Stream.runForEach((chunk) =>
          Effect.sleep("10 millis").pipe(
            Effect.andThen(
              Effect.sync(() => {
                seen.push(chunk.value);
              }),
            ),
          ),
        ),
      ),
    );

    expect(seen).toHaveLength(12);
    expect(Math.max(...seen)).toBeLessThan(totalFrames);
    expect(bridge.cancelCalls.length).toBeGreaterThan(0);

    renderer.dispose();
  });
});
