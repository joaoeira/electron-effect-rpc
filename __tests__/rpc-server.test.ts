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

  it("endpoint_rejects_missing_implementation", () => {
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

  it("endpoint_rejects_unknown_implementation_key", () => {
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

  it("endpoint_uses_custom_rpc_channel_prefix", () => {
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

  it("endpoint_decode_failure_includes_scope_name_payload", async () => {
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

  it("endpoint_returns_defect_for_NoError_typed_failure", async () => {
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

  it("endpoint_returns_defect_for_effect_die", async () => {
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

  it("endpoint_returns_defect_for_effect_interrupt", async () => {
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

  it("endpoint_reports_protocol_error_on_success_encode_failure", async () => {
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

  it("endpoint_reports_protocol_error_on_failure_encode_failure", async () => {
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

  it("endpoint_start_idempotent_when_running", () => {
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

  it("endpoint_stop_idempotent_when_stopped", () => {
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

  it("endpoint_runtime_is_used_for_effect_execution", async () => {
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

  it("endpoint_handles_parallel_invocations_without_cross_talk", async () => {
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

  it("cleans up already-registered handlers when start fails mid-registration", () => {
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

  it("marks endpoint as stopped even if removeHandler throws", () => {
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

  it("finalizes disposal even if stop throws", () => {
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
