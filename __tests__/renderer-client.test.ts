import { describe, expect, it } from "bun:test";
import * as S from "@effect/schema/Schema";
import { Effect } from "effect";
import { defineContract, exitSchemaFor, rpc } from "../src/contract.ts";
import { createRpcClient, RpcDefectError } from "../src/renderer.ts";
import { createInvokeStub } from "../src/testing.ts";

class AccessDeniedError extends S.TaggedError<AccessDeniedError>()(
  "AccessDeniedError",
  {
    message: S.String,
  }
) {}

describe("createRpcClient", () => {
  const Add = rpc(
    "Add",
    S.Struct({ a: S.Number, b: S.Number }),
    S.Struct({ sum: S.Number })
  );

  const Ping = rpc("Ping", S.Struct({}), S.Struct({ ok: S.Boolean }));

  const MayFail = rpc(
    "MayFail",
    S.Struct({}),
    S.Struct({ ok: S.Boolean }),
    AccessDeniedError
  );

  const contract = defineContract({
    methods: [Add, Ping, MayFail] as const,
    events: [] as const,
  });

  it("requires an invoke function", () => {
    expect(() => createRpcClient(contract)).toThrow(
      /RpcClientOptions.invoke is required/
    );
  });

  it("encodes requests and decodes success envelopes", async () => {
    const invoke = createInvokeStub(async () => ({
      type: "success",
      data: { sum: 3 },
    }));

    const client = createRpcClient(contract, { invoke });
    const result = await client.Add({ a: 1, b: 2 });

    expect(result).toEqual({ sum: 3 });
    expect(invoke.invocations).toEqual([
      {
        method: "Add",
        payload: { a: 1, b: 2 },
      },
    ]);
  });

  it("supports zero-argument calls for empty request schemas", async () => {
    const invoke = createInvokeStub(async () => ({
      type: "success",
      data: { ok: true },
    }));

    const client = createRpcClient(contract, { invoke });
    const result = await client.Ping();

    expect(result).toEqual({ ok: true });
    expect(invoke.invocations).toEqual([
      {
        method: "Ping",
        payload: {},
      },
    ]);
  });

  it("preserves explicit null inputs instead of replacing them with empty objects", async () => {
    const AcceptNull = rpc("AcceptNull", S.Null, S.Struct({ ok: S.Boolean }));
    const nullContract = defineContract({
      methods: [AcceptNull] as const,
      events: [] as const,
    });

    const invoke = createInvokeStub(async (_method, payload) => ({
      type: "success",
      data: { ok: payload === null },
    }));

    const client = createRpcClient(nullContract, { invoke });
    const result = await client.AcceptNull(null);

    expect(result).toEqual({ ok: true });
    expect(invoke.invocations).toEqual([
      {
        method: "AcceptNull",
        payload: null,
      },
    ]);
  });

  it("throws typed failures from failure envelopes", async () => {
    const invoke = createInvokeStub(async () => ({
      type: "failure",
      error: {
        tag: "AccessDeniedError",
        data: {
          _tag: "AccessDeniedError",
          message: "denied",
        },
      },
    }));

    const client = createRpcClient(contract, { invoke });

    let thrown: unknown;
    try {
      await client.MayFail();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AccessDeniedError);
    if (thrown instanceof AccessDeniedError) {
      expect(thrown.message).toBe("denied");
    }
  });

  it("wraps defects in RpcDefectError", async () => {
    const invoke = createInvokeStub(async () => ({
      type: "defect",
      message: "boom",
      cause: "boom",
    }));

    const client = createRpcClient(contract, { invoke });

    let thrown: unknown;
    try {
      await client.Add({ a: 1, b: 2 });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(RpcDefectError);
    if (thrown instanceof RpcDefectError) {
      expect(thrown.message).toBe("boom");
      expect(thrown.cause).toBe("boom");
    }
  });

  it("reports malformed response envelopes as protocol errors", async () => {
    const protocolErrors: unknown[] = [];
    const invoke = createInvokeStub(async () => ({ not: "an-envelope" }));

    const client = createRpcClient(contract, {
      invoke,
      diagnostics: {
        onProtocolError: (context) => {
          protocolErrors.push(context);
        },
      },
    });

    let thrown: unknown;
    try {
      await client.Add({ a: 1, b: 2 });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    if (thrown instanceof Error) {
      expect(thrown.message).toContain("valid envelope");
    }

    expect(protocolErrors.length).toBe(1);
  });

  it("supports legacy Exit response decoding in dual mode", async () => {
    const encodeLegacyExit = S.encodeUnknownSync(exitSchemaFor(Add));

    const invoke = createInvokeStub(async () => {
      const exit = await Effect.runPromiseExit(Effect.succeed({ sum: 10 }));
      return encodeLegacyExit(exit);
    });

    const client = createRpcClient(contract, {
      invoke,
      rpcDecodeMode: "dual",
    });

    const result = await client.Add({ a: 4, b: 6 });
    expect(result).toEqual({ sum: 10 });
  });
});
