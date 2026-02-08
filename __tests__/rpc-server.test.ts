import { describe, expect, it } from "bun:test";
import * as S from "@effect/schema/Schema";
import { Effect } from "effect";
import * as Runtime from "effect/Runtime";
import { defineContract, rpc } from "../src/contract.ts";
import { createRpcEndpoint } from "../src/main.ts";
import { parseRpcResponseEnvelope } from "../src/protocol.ts";
import type { IpcMainLike } from "../src/types.ts";

class DomainError extends S.TaggedError<DomainError>()("DomainError", {
  message: S.String,
}) {}

const createIpcMainStub = () => {
  const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();

  const ipcMain: IpcMainLike = {
    handle: (channel, listener) => {
      handlers.set(channel, listener);
    },
    removeHandler: (channel) => {
      handlers.delete(channel);
    },
  };

  return { ipcMain, handlers };
};

const requireHandler = (
  handlers: Map<string, (event: unknown, payload: unknown) => unknown>,
  channel: string
) => {
  const handler = handlers.get(channel);
  if (!handler) {
    throw new Error(`Missing handler for channel: ${channel}`);
  }

  return handler;
};

describe("createRpcEndpoint", () => {
  const Add = rpc(
    "Add",
    S.Struct({ a: S.Number, b: S.Number }),
    S.Struct({ sum: S.Number })
  );

  const Fail = rpc(
    "Fail",
    S.Struct({}),
    S.Struct({ ok: S.Boolean }),
    DomainError
  );

  const contract = defineContract({
    methods: [Add, Fail] as const,
    events: [] as const,
  });

  it("registers handlers on start and unregisters on stop", () => {
    const { ipcMain, handlers } = createIpcMainStub();

    const endpoint = createRpcEndpoint(contract, ipcMain, {
      Add: ({ a, b }) => Effect.succeed({ sum: a + b }),
      Fail: () => Effect.fail(new DomainError({ message: "denied" })),
    }, {
      runtime: Runtime.defaultRuntime,
    });

    expect(handlers.size).toBe(0);
    expect(endpoint.isRunning()).toBe(false);

    endpoint.start();
    expect(endpoint.isRunning()).toBe(true);
    expect(handlers.has("rpc/Add")).toBe(true);
    expect(handlers.has("rpc/Fail")).toBe(true);

    endpoint.stop();
    expect(endpoint.isRunning()).toBe(false);
    expect(handlers.size).toBe(0);
  });

  it("returns success envelopes", async () => {
    const { ipcMain, handlers } = createIpcMainStub();

    const endpoint = createRpcEndpoint(contract, ipcMain, {
      Add: ({ a, b }) => Effect.succeed({ sum: a + b }),
      Fail: () => Effect.fail(new DomainError({ message: "denied" })),
    }, {
      runtime: Runtime.defaultRuntime,
    });

    endpoint.start();

    const handler = requireHandler(handlers, "rpc/Add");
    const raw = await handler({}, { a: 2, b: 5 });
    const envelope = parseRpcResponseEnvelope(raw);

    expect(envelope).toEqual({
      type: "success",
      data: { sum: 7 },
    });
  });

  it("returns typed failure envelopes", async () => {
    const { ipcMain, handlers } = createIpcMainStub();

    const endpoint = createRpcEndpoint(contract, ipcMain, {
      Add: ({ a, b }) => Effect.succeed({ sum: a + b }),
      Fail: () => Effect.fail(new DomainError({ message: "denied" })),
    }, {
      runtime: Runtime.defaultRuntime,
    });

    endpoint.start();

    const handler = requireHandler(handlers, "rpc/Fail");
    const raw = await handler({}, {});
    const envelope = parseRpcResponseEnvelope(raw);

    expect(envelope?.type).toBe("failure");
    if (!envelope || envelope.type !== "failure") {
      throw new Error("Expected failure envelope");
    }

    expect(envelope.error.tag).toBe("DomainError");

    const decoded = S.decodeUnknownSync(DomainError)(envelope.error.data);
    expect(decoded).toBeInstanceOf(DomainError);
    expect(decoded.message).toBe("denied");
  });

  it("returns defect envelopes when request payload decoding fails", async () => {
    const { ipcMain, handlers } = createIpcMainStub();
    const decodeFailures: unknown[] = [];

    const endpoint = createRpcEndpoint(
      contract,
      ipcMain,
      {
        Add: ({ a, b }) => Effect.succeed({ sum: a + b }),
        Fail: () => Effect.fail(new DomainError({ message: "denied" })),
      },
      {
        runtime: Runtime.defaultRuntime,
        diagnostics: {
          onDecodeFailure: (context) => {
            decodeFailures.push(context);
          },
        },
      }
    );

    endpoint.start();

    const handler = requireHandler(handlers, "rpc/Add");
    const raw = await handler({}, { a: 1 });
    const envelope = parseRpcResponseEnvelope(raw);

    expect(envelope?.type).toBe("defect");
    expect(decodeFailures.length).toBe(1);
  });

  it("converts synchronous implementation throws into defect envelopes", async () => {
    const ThrowSync = rpc("ThrowSync", S.Struct({}), S.Struct({ ok: S.Boolean }));
    const throwContract = defineContract({
      methods: [ThrowSync] as const,
      events: [] as const,
    });

    const { ipcMain, handlers } = createIpcMainStub();

    const endpoint = createRpcEndpoint(throwContract, ipcMain, {
      ThrowSync: () => {
        throw new Error("sync boom");
      },
    }, {
      runtime: Runtime.defaultRuntime,
    });

    endpoint.start();

    const handler = requireHandler(handlers, "rpc/ThrowSync");
    const raw = await handler({}, {});
    const envelope = parseRpcResponseEnvelope(raw);

    expect(envelope?.type).toBe("defect");
    if (!envelope || envelope.type !== "defect") {
      throw new Error("Expected defect envelope");
    }

    expect(envelope.message).toContain("sync boom");
  });

  it("is idempotent on stop/dispose and rejects restart after dispose", () => {
    const { ipcMain } = createIpcMainStub();

    const endpoint = createRpcEndpoint(contract, ipcMain, {
      Add: ({ a, b }) => Effect.succeed({ sum: a + b }),
      Fail: () => Effect.fail(new DomainError({ message: "denied" })),
    }, {
      runtime: Runtime.defaultRuntime,
    });

    endpoint.start();
    endpoint.stop();
    endpoint.stop();
    endpoint.dispose();
    endpoint.dispose();

    expect(() => endpoint.start()).toThrow(/disposed/i);
  });
});
