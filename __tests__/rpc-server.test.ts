import { describe, expect, it } from "bun:test";
import * as S from "@effect/schema/Schema";
import { Context, Effect } from "effect";
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

  it("when an endpoint starts and stops normally, then handlers are registered and removed", () => {
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

  it("when a contract method has no implementation, then endpoint creation throws", () => {
    const { ipcMain } = createIpcMainStub();

    expect(() =>
      createRpcEndpoint(
        contract,
        ipcMain,
        {
          Add: ({ a, b }) => Effect.succeed({ sum: a + b }),
        } as never,
        {
          runtime: Runtime.defaultRuntime,
        }
      )
    ).toThrow(/Missing implementation for RPC method: Fail/);
  });

  it("when implementations include a method not in the contract, then endpoint creation throws", () => {
    const { ipcMain } = createIpcMainStub();

    expect(() =>
      createRpcEndpoint(
        contract,
        ipcMain,
        {
          Add: ({ a, b }) => Effect.succeed({ sum: a + b }),
          Fail: () => Effect.fail(new DomainError({ message: "denied" })),
          Extra: () => Effect.succeed({ ok: true }),
        } as never,
        {
          runtime: Runtime.defaultRuntime,
        }
      )
    ).toThrow(/unknown RPC method: Extra/);
  });

  it("when a custom rpc channel prefix is configured, then handlers are registered with that prefix", () => {
    const { ipcMain, handlers } = createIpcMainStub();

    const endpoint = createRpcEndpoint(contract, ipcMain, {
      Add: ({ a, b }) => Effect.succeed({ sum: a + b }),
      Fail: () => Effect.fail(new DomainError({ message: "denied" })),
    }, {
      runtime: Runtime.defaultRuntime,
      channelPrefix: {
        rpc: "rpc-custom/",
        event: "evt-custom/",
      },
    });

    endpoint.start();
    expect(handlers.has("rpc-custom/Add")).toBe(true);
    expect(handlers.has("rpc-custom/Fail")).toBe(true);
  });

  it("when a handler succeeds, then the endpoint returns a success envelope", async () => {
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

  it("when a handler fails with a tagged error, then the endpoint returns a typed failure envelope", async () => {
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

  it("when request payload decoding fails, then the endpoint returns a defect envelope", async () => {
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

  it("when request decoding fails, then decode diagnostics include scope, method name, payload, and cause", async () => {
    const { ipcMain, handlers } = createIpcMainStub();
    const decodeFailures: Array<Record<string, unknown>> = [];

    const endpoint = createRpcEndpoint(contract, ipcMain, {
      Add: ({ a, b }) => Effect.succeed({ sum: a + b }),
      Fail: () => Effect.fail(new DomainError({ message: "denied" })),
    }, {
      runtime: Runtime.defaultRuntime,
      diagnostics: {
        onDecodeFailure: (context) => {
          decodeFailures.push(context as unknown as Record<string, unknown>);
        },
      },
    });

    endpoint.start();
    const handler = requireHandler(handlers, "rpc/Add");
    await handler({}, { a: 1 });

    expect(decodeFailures).toHaveLength(1);
    expect(decodeFailures[0]).toMatchObject({
      scope: "rpc-request",
      name: "Add",
      payload: { a: 1 },
    });
    expect(decodeFailures[0]?.cause).toBeDefined();
  });

  it("when a NoError method returns typed failure, then endpoint responds with defect envelope", async () => {
    const NoErrorMethod = rpc("NoErrorMethod", S.Struct({}), S.Struct({ ok: S.Boolean }));
    const noErrorContract = defineContract({
      methods: [NoErrorMethod] as const,
      events: [] as const,
    });
    const { ipcMain, handlers } = createIpcMainStub();

    const endpoint = createRpcEndpoint(noErrorContract, ipcMain, {
      NoErrorMethod: () =>
        Effect.fail(new DomainError({ message: "typed failure on NoError method" })) as never,
    }, {
      runtime: Runtime.defaultRuntime,
    });

    endpoint.start();
    const handler = requireHandler(handlers, "rpc/NoErrorMethod");
    const envelope = parseRpcResponseEnvelope(await handler({}, {}));

    expect(envelope?.type).toBe("defect");
    if (envelope?.type === "defect") {
      expect(envelope.message).toContain("declares NoError");
    }
  });

  it("when handler dies with a defect, then endpoint responds with defect envelope", async () => {
    const DieMethod = rpc("DieMethod", S.Struct({}), S.Struct({ ok: S.Boolean }));
    const dieContract = defineContract({
      methods: [DieMethod] as const,
      events: [] as const,
    });
    const { ipcMain, handlers } = createIpcMainStub();

    const endpoint = createRpcEndpoint(dieContract, ipcMain, {
      DieMethod: () => Effect.dieMessage("die boom"),
    }, {
      runtime: Runtime.defaultRuntime,
    });

    endpoint.start();
    const handler = requireHandler(handlers, "rpc/DieMethod");
    const envelope = parseRpcResponseEnvelope(await handler({}, {}));

    expect(envelope?.type).toBe("defect");
    if (envelope?.type === "defect") {
      expect(envelope.message).toContain("die boom");
    }
  });

  it("when handler is interrupted, then endpoint responds with defect envelope", async () => {
    const InterruptMethod = rpc(
      "InterruptMethod",
      S.Struct({}),
      S.Struct({ ok: S.Boolean })
    );
    const interruptContract = defineContract({
      methods: [InterruptMethod] as const,
      events: [] as const,
    });
    const { ipcMain, handlers } = createIpcMainStub();

    const endpoint = createRpcEndpoint(interruptContract, ipcMain, {
      InterruptMethod: () => Effect.interrupt,
    }, {
      runtime: Runtime.defaultRuntime,
    });

    endpoint.start();
    const handler = requireHandler(handlers, "rpc/InterruptMethod");
    const envelope = parseRpcResponseEnvelope(await handler({}, {}));

    expect(envelope?.type).toBe("defect");
    if (envelope?.type === "defect") {
      expect(envelope.message.toLowerCase()).toContain("interrupted");
    }
  });

  it("when success payload encoding fails, then protocol diagnostics are reported and defect envelope is returned", async () => {
    const SuccessEncodeBreak = rpc(
      "SuccessEncodeBreak",
      S.Struct({}),
      S.Struct({ sum: S.Number })
    );
    const successEncodeContract = defineContract({
      methods: [SuccessEncodeBreak] as const,
      events: [] as const,
    });
    const { ipcMain, handlers } = createIpcMainStub();
    const protocolErrors: unknown[] = [];

    const endpoint = createRpcEndpoint(successEncodeContract, ipcMain, {
      SuccessEncodeBreak: () => Effect.succeed({ sum: "bad" } as never),
    }, {
      runtime: Runtime.defaultRuntime,
      diagnostics: {
        onProtocolError: (context) => {
          protocolErrors.push(context);
        },
      },
    });

    endpoint.start();
    const handler = requireHandler(handlers, "rpc/SuccessEncodeBreak");
    const envelope = parseRpcResponseEnvelope(await handler({}, {}));

    expect(envelope?.type).toBe("defect");
    expect(protocolErrors).toHaveLength(1);
  });

  it("when failure payload encoding fails, then protocol diagnostics are reported and defect envelope is returned", async () => {
    const FailureEncodeBreak = rpc(
      "FailureEncodeBreak",
      S.Struct({}),
      S.Struct({ ok: S.Boolean }),
      DomainError
    );
    const failureEncodeContract = defineContract({
      methods: [FailureEncodeBreak] as const,
      events: [] as const,
    });
    const { ipcMain, handlers } = createIpcMainStub();
    const protocolErrors: unknown[] = [];

    const endpoint = createRpcEndpoint(failureEncodeContract, ipcMain, {
      FailureEncodeBreak: () => Effect.fail({ _tag: "DomainError" } as never),
    }, {
      runtime: Runtime.defaultRuntime,
      diagnostics: {
        onProtocolError: (context) => {
          protocolErrors.push(context);
        },
      },
    });

    endpoint.start();
    const handler = requireHandler(handlers, "rpc/FailureEncodeBreak");
    const envelope = parseRpcResponseEnvelope(await handler({}, {}));

    expect(envelope?.type).toBe("defect");
    expect(protocolErrors).toHaveLength(1);
  });

  it("when endpoint emits decode-failure diagnostics, then context shape remains stable", async () => {
    const { ipcMain, handlers } = createIpcMainStub();
    const decodeFailures: Array<Record<string, unknown>> = [];

    const endpoint = createRpcEndpoint(contract, ipcMain, {
      Add: ({ a, b }) => Effect.succeed({ sum: a + b }),
      Fail: () => Effect.fail(new DomainError({ message: "denied" })),
    }, {
      runtime: Runtime.defaultRuntime,
      diagnostics: {
        onDecodeFailure: (context) => {
          decodeFailures.push(context as unknown as Record<string, unknown>);
        },
      },
    });

    endpoint.start();
    const handler = requireHandler(handlers, "rpc/Add");
    await handler({}, { a: 1 });

    expect(decodeFailures).toHaveLength(1);
    expect(decodeFailures[0]).toMatchObject({
      scope: "rpc-request",
      name: "Add",
      payload: { a: 1 },
    });
    expect(typeof decodeFailures[0]?.cause).not.toBe("undefined");
  });

  it("when endpoint emits protocol-error diagnostics, then context shape remains stable", async () => {
    const Broken = rpc("Broken", S.Struct({}), S.Struct({ sum: S.Number }));
    const brokenContract = defineContract({
      methods: [Broken] as const,
      events: [] as const,
    });
    const { ipcMain, handlers } = createIpcMainStub();
    const protocolErrors: Array<Record<string, unknown>> = [];

    const endpoint = createRpcEndpoint(brokenContract, ipcMain, {
      Broken: () => Effect.succeed({ sum: "bad" } as never),
    }, {
      runtime: Runtime.defaultRuntime,
      diagnostics: {
        onProtocolError: (context) => {
          protocolErrors.push(context as unknown as Record<string, unknown>);
        },
      },
    });

    endpoint.start();
    const handler = requireHandler(handlers, "rpc/Broken");
    await handler({}, {});

    expect(protocolErrors).toHaveLength(1);
    expect(protocolErrors[0]).toMatchObject({
      method: "Broken",
      response: { sum: "bad" },
    });
    expect(typeof protocolErrors[0]?.cause).not.toBe("undefined");
  });

  it("when endpoint diagnostics callback throws, then transport still returns a defect envelope", async () => {
    const Broken = rpc("Broken", S.Struct({}), S.Struct({ sum: S.Number }));
    const brokenContract = defineContract({
      methods: [Broken] as const,
      events: [] as const,
    });
    const { ipcMain, handlers } = createIpcMainStub();

    const endpoint = createRpcEndpoint(brokenContract, ipcMain, {
      Broken: () => Effect.succeed({ sum: "bad" } as never),
    }, {
      runtime: Runtime.defaultRuntime,
      diagnostics: {
        onProtocolError: () => {
          throw new Error("diagnostics crashed");
        },
      },
    });

    endpoint.start();
    const handler = requireHandler(handlers, "rpc/Broken");

    expect(await handler({}, {})).toEqual({
      type: "defect",
      message: expect.stringContaining("success encoding failed"),
      cause: expect.any(String),
    });
  });

  it("when rpc execution succeeds, then failure diagnostics are not emitted", async () => {
    const { ipcMain, handlers } = createIpcMainStub();
    const decodeFailures: unknown[] = [];
    const protocolErrors: unknown[] = [];

    const endpoint = createRpcEndpoint(contract, ipcMain, {
      Add: ({ a, b }) => Effect.succeed({ sum: a + b }),
      Fail: () => Effect.fail(new DomainError({ message: "denied" })),
    }, {
      runtime: Runtime.defaultRuntime,
      diagnostics: {
        onDecodeFailure: (context) => {
          decodeFailures.push(context);
        },
        onProtocolError: (context) => {
          protocolErrors.push(context);
        },
      },
    });

    endpoint.start();
    const handler = requireHandler(handlers, "rpc/Add");
    const envelope = parseRpcResponseEnvelope(await handler({}, { a: 1, b: 2 }));

    expect(envelope).toEqual({
      type: "success",
      data: { sum: 3 },
    });
    expect(decodeFailures).toEqual([]);
    expect(protocolErrors).toEqual([]);
  });

  it("when an implementation throws synchronously, then the endpoint returns a defect envelope", async () => {
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

  it("when stop or dispose is called repeatedly, then cleanup is idempotent and restart after dispose is rejected", () => {
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

  it("when start is called twice while running, then handler registration happens only once", () => {
    const handleCalls: string[] = [];
    const removeCalls: string[] = [];

    const ipcMain: IpcMainLike = {
      handle: (channel) => {
        handleCalls.push(channel);
      },
      removeHandler: (channel) => {
        removeCalls.push(channel);
      },
    };

    const endpoint = createRpcEndpoint(contract, ipcMain, {
      Add: ({ a, b }) => Effect.succeed({ sum: a + b }),
      Fail: () => Effect.fail(new DomainError({ message: "denied" })),
    }, {
      runtime: Runtime.defaultRuntime,
    });

    endpoint.start();
    endpoint.start();

    expect(handleCalls).toHaveLength(2);
    expect(handleCalls).toEqual(expect.arrayContaining(["rpc/Add", "rpc/Fail"]));
    expect(removeCalls).toHaveLength(0);
  });

  it("when stop is called twice, then handler removal happens only once", () => {
    const removeCalls: string[] = [];

    const ipcMain: IpcMainLike = {
      handle: () => {},
      removeHandler: (channel) => {
        removeCalls.push(channel);
      },
    };

    const endpoint = createRpcEndpoint(contract, ipcMain, {
      Add: ({ a, b }) => Effect.succeed({ sum: a + b }),
      Fail: () => Effect.fail(new DomainError({ message: "denied" })),
    }, {
      runtime: Runtime.defaultRuntime,
    });

    endpoint.start();
    endpoint.stop();
    endpoint.stop();

    expect(removeCalls).toHaveLength(2);
    expect(removeCalls).toEqual(expect.arrayContaining(["rpc/Add", "rpc/Fail"]));
  });

  it("when a runtime provides services, then handlers resolve those services through the provided runtime", async () => {
    class Offset extends Context.Tag("Offset")<Offset, number>() {}

    const WithRuntime = rpc(
      "WithRuntime",
      S.Struct({ a: S.Number, b: S.Number }),
      S.Struct({ sum: S.Number })
    );
    const runtimeContract = defineContract({
      methods: [WithRuntime] as const,
      events: [] as const,
    });
    const { ipcMain, handlers } = createIpcMainStub();

    const runtime = Runtime.defaultRuntime.pipe(
      Runtime.provideService(Offset, 5)
    );

    const endpoint = createRpcEndpoint(runtimeContract, ipcMain, {
      WithRuntime: ({ a, b }) =>
        Effect.contextWith((ctx) => {
          const offset = Context.get(ctx, Offset);
          return { sum: a + b + offset };
        }),
    }, {
      runtime,
    });

    endpoint.start();
    const handler = requireHandler(handlers, "rpc/WithRuntime");
    const envelope = parseRpcResponseEnvelope(await handler({}, { a: 2, b: 3 }));

    expect(envelope).toEqual({
      type: "success",
      data: { sum: 10 },
    });
  });

  it("when multiple rpc invocations run concurrently, then each response matches its own input", async () => {
    const Parallel = rpc(
      "Parallel",
      S.Struct({ a: S.Number, b: S.Number }),
      S.Struct({ sum: S.Number })
    );
    const parallelContract = defineContract({
      methods: [Parallel] as const,
      events: [] as const,
    });
    const { ipcMain, handlers } = createIpcMainStub();

    const endpoint = createRpcEndpoint(parallelContract, ipcMain, {
      Parallel: ({ a, b }) =>
        Effect.promise(
          () =>
            new Promise<{ sum: number }>((resolve) => {
              setTimeout(() => resolve({ sum: a + b }), a > b ? 25 : 5);
            })
        ),
    }, {
      runtime: Runtime.defaultRuntime,
    });

    endpoint.start();
    const handler = requireHandler(handlers, "rpc/Parallel");

    const [first, second] = await Promise.all([
      handler({}, { a: 10, b: 1 }),
      handler({}, { a: 2, b: 3 }),
    ]);

    const firstEnvelope = parseRpcResponseEnvelope(first);
    const secondEnvelope = parseRpcResponseEnvelope(second);

    expect(firstEnvelope).toEqual({
      type: "success",
      data: { sum: 11 },
    });
    expect(secondEnvelope).toEqual({
      type: "success",
      data: { sum: 5 },
    });
  });

  it("when start fails partway through registration, then already-registered handlers are cleaned up", () => {
    const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();

    const ipcMain: IpcMainLike = {
      handle: (channel, listener) => {
        if (channel === "rpc/Fail") {
          throw new Error("duplicate channel");
        }

        handlers.set(channel, listener);
      },
      removeHandler: (channel) => {
        handlers.delete(channel);
      },
    };

    const endpoint = createRpcEndpoint(contract, ipcMain, {
      Add: ({ a, b }) => Effect.succeed({ sum: a + b }),
      Fail: () => Effect.fail(new DomainError({ message: "denied" })),
    }, {
      runtime: Runtime.defaultRuntime,
    });

    expect(() => endpoint.start()).toThrow(/duplicate channel/);
    expect(endpoint.isRunning()).toBe(false);
    expect(handlers.size).toBe(0);

    endpoint.stop();
    expect(handlers.size).toBe(0);
  });

  it("when removeHandler throws during stop, then the endpoint is still marked as stopped", () => {
    const removals: string[] = [];
    const throwsOn = new Set<string>(["rpc/Add"]);

    const ipcMain: IpcMainLike = {
      handle: () => {},
      removeHandler: (channel) => {
        removals.push(channel);
        if (throwsOn.has(channel)) {
          throw new Error(`remove failed for ${channel}`);
        }
      },
    };

    const endpoint = createRpcEndpoint(contract, ipcMain, {
      Add: ({ a, b }) => Effect.succeed({ sum: a + b }),
      Fail: () => Effect.fail(new DomainError({ message: "denied" })),
    }, {
      runtime: Runtime.defaultRuntime,
    });

    endpoint.start();
    expect(endpoint.isRunning()).toBe(true);

    expect(() => endpoint.stop()).toThrow(/remove failed for rpc\/Add/);
    expect(endpoint.isRunning()).toBe(false);
    expect(removals).toEqual(expect.arrayContaining(["rpc/Add", "rpc/Fail"]));
  });

  it("when stop throws during dispose, then disposal is still finalized", () => {
    const ipcMain: IpcMainLike = {
      handle: () => {},
      removeHandler: () => {
        throw new Error("remove failed");
      },
    };

    const endpoint = createRpcEndpoint(contract, ipcMain, {
      Add: ({ a, b }) => Effect.succeed({ sum: a + b }),
      Fail: () => Effect.fail(new DomainError({ message: "denied" })),
    }, {
      runtime: Runtime.defaultRuntime,
    });

    endpoint.start();
    expect(() => endpoint.dispose()).toThrow(/remove failed/);
    expect(() => endpoint.start()).toThrow(/disposed/i);
  });
});
