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

  it("when client uses custom invoke method name verbatim", async () => {
    const MethodWithPath = rpc(
      "system/get.version",
      S.Struct({}),
      S.Struct({ ok: S.Boolean })
    );
    const specialContract = defineContract({
      methods: [MethodWithPath] as const,
      events: [] as const,
    });
    const invoke = createInvokeStub(async () => ({
      type: "success",
      data: { ok: true },
    }));

    const client = createRpcClient(specialContract, { invoke });
    await client["system/get.version"]();

    expect(invoke.invocations).toEqual([
      {
        method: "system/get.version",
        payload: {},
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

  it("when client throws defect when failure received for NoError method", async () => {
    const invoke = createInvokeStub(async () => ({
      type: "failure",
      error: {
        tag: "DomainError",
        data: { _tag: "DomainError", message: "nope" },
      },
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
      expect(thrown.message).toContain("declares NoError");
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
    const malformed = { not: "an-envelope" };
    const invoke = createInvokeStub(async () => malformed);

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
    expect(protocolErrors[0]).toMatchObject({
      method: "Add",
      response: malformed,
    });
  });

  it("when client protocol error context contains raw response", async () => {
    const protocolErrors: unknown[] = [];
    const rawResponse = { impossible: true };
    const invoke = createInvokeStub(async () => rawResponse);

    const client = createRpcClient(contract, {
      invoke,
      diagnostics: {
        onProtocolError: (context) => {
          protocolErrors.push(context);
        },
      },
    });

    await expect(client.Add({ a: 1, b: 2 })).rejects.toThrow(/valid envelope/);
    expect(protocolErrors).toHaveLength(1);
    expect(protocolErrors[0]).toMatchObject({
      method: "Add",
      response: rawResponse,
    });
  });

  it("when client reports decode failure on invalid success payload", async () => {
    const decodeFailures: unknown[] = [];
    const invoke = createInvokeStub(async () => ({
      type: "success",
      data: { sum: "wrong-type" },
    }));

    const client = createRpcClient(contract, {
      invoke,
      diagnostics: {
        onDecodeFailure: (context) => {
          decodeFailures.push(context);
        },
      },
    });

    await expect(client.Add({ a: 1, b: 2 })).rejects.toThrow(
      /success payload decoding failed/
    );
    expect(decodeFailures).toHaveLength(1);
    expect(decodeFailures[0]).toMatchObject({
      scope: "rpc-response",
      name: "Add",
      payload: { sum: "wrong-type" },
    });
  });

  it("when client reports decode failure on invalid failure payload", async () => {
    const decodeFailures: unknown[] = [];
    const invoke = createInvokeStub(async () => ({
      type: "failure",
      error: {
        tag: "AccessDeniedError",
        data: { _tag: "AccessDeniedError" },
      },
    }));

    const client = createRpcClient(contract, {
      invoke,
      diagnostics: {
        onDecodeFailure: (context) => {
          decodeFailures.push(context);
        },
      },
    });

    await expect(client.MayFail()).rejects.toThrow(/failure payload decoding failed/);
    expect(decodeFailures).toHaveLength(1);
    expect(decodeFailures[0]).toMatchObject({
      scope: "rpc-response",
      name: "MayFail",
    });
  });

  it("when diagnostics decode failure context shape is stable", async () => {
    const decodeFailures: Array<Record<string, unknown>> = [];
    const invoke = createInvokeStub(async () => ({
      type: "success",
      data: { sum: "wrong-type" },
    }));

    const client = createRpcClient(contract, {
      invoke,
      diagnostics: {
        onDecodeFailure: (context) => {
          decodeFailures.push(context as unknown as Record<string, unknown>);
        },
      },
    });

    await expect(client.Add({ a: 1, b: 2 })).rejects.toThrow();
    expect(decodeFailures).toHaveLength(1);
    expect(decodeFailures[0]).toMatchObject({
      scope: "rpc-response",
      name: "Add",
      payload: { sum: "wrong-type" },
    });
    expect(typeof decodeFailures[0]?.cause).not.toBe("undefined");
  });

  it("when diagnostics protocol error context shape is stable", async () => {
    const protocolErrors: Array<Record<string, unknown>> = [];
    const malformed = { nope: true };
    const invoke = createInvokeStub(async () => malformed);

    const client = createRpcClient(contract, {
      invoke,
      diagnostics: {
        onProtocolError: (context) => {
          protocolErrors.push(context as unknown as Record<string, unknown>);
        },
      },
    });

    await expect(client.Add({ a: 1, b: 2 })).rejects.toThrow(/valid envelope/);
    expect(protocolErrors).toHaveLength(1);
    expect(protocolErrors[0]).toMatchObject({
      method: "Add",
      response: malformed,
    });
    expect(typeof protocolErrors[0]?.cause).not.toBe("undefined");
  });

  it("when diagnostics callbacks throw do not crash transport", async () => {
    const invoke = createInvokeStub(async () => ({ nope: true }));
    const client = createRpcClient(contract, {
      invoke,
      diagnostics: {
        onProtocolError: () => {
          throw new Error("diagnostics crashed");
        },
      },
    });

    await expect(client.Add({ a: 1, b: 2 })).rejects.toThrow(/valid envelope/);
  });

  it("reports invoke rejections as protocol defects", async () => {
    const protocolErrors: unknown[] = [];
    const invoke = createInvokeStub(async () => {
      throw new Error("ipc invoke failed");
    });

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

    expect(thrown).toBeInstanceOf(RpcDefectError);
    if (thrown instanceof RpcDefectError) {
      expect(thrown.message).toContain("invoke failed");
      expect(thrown.cause).toBeInstanceOf(Error);
    }

    expect(protocolErrors.length).toBe(1);
  });

  it("when success paths do not emit failure diagnostics", async () => {
    const decodeFailures: unknown[] = [];
    const protocolErrors: unknown[] = [];
    const invoke = createInvokeStub(async () => ({
      type: "success",
      data: { sum: 8 },
    }));

    const client = createRpcClient(contract, {
      invoke,
      diagnostics: {
        onDecodeFailure: (context) => {
          decodeFailures.push(context);
        },
        onProtocolError: (context) => {
          protocolErrors.push(context);
        },
      },
    });

    await expect(client.Add({ a: 3, b: 5 })).resolves.toEqual({ sum: 8 });
    expect(decodeFailures).toEqual([]);
    expect(protocolErrors).toEqual([]);
  });

  it("when client preserves explicit undefined input", async () => {
    const AcceptUndefined = rpc(
      "AcceptUndefined",
      S.Undefined,
      S.Struct({ ok: S.Boolean })
    );
    const undefinedContract = defineContract({
      methods: [AcceptUndefined] as const,
      events: [] as const,
    });
    const invoke = createInvokeStub(async (_method, payload) => ({
      type: "success",
      data: { ok: payload === undefined },
    }));

    const client = createRpcClient(undefinedContract, { invoke });
    const acceptUndefined =
      client.AcceptUndefined as unknown as (
        value: undefined
      ) => Promise<{ ok: boolean }>;
    const result = await acceptUndefined(undefined);

    expect(result).toEqual({ ok: true });
    expect(invoke.invocations).toEqual([
      {
        method: "AcceptUndefined",
        payload: undefined,
      },
    ]);
  });

  it("when client omitted input uses default decode only when arg absent", async () => {
    const AcceptNull = rpc("AcceptNull", S.Null, S.Struct({ ok: S.Boolean }));
    const nullContract = defineContract({
      methods: [AcceptNull] as const,
      events: [] as const,
    });

    const invoke = createInvokeStub(async () => ({
      type: "success",
      data: { ok: true },
    }));
    const client = createRpcClient(nullContract, { invoke });
    const noArgCaller =
      client.AcceptNull as unknown as () => Promise<{ ok: boolean }>;

    expect(() => noArgCaller()).toThrow(/Expected null, actual \{\}/);
    expect(invoke.invocations).toEqual([]);
  });

  it("when client envelope mode rejects legacy exit payload", async () => {
    const encodeLegacyExit = S.encodeUnknownSync(exitSchemaFor(Add));
    const invoke = createInvokeStub(async () => {
      const exit = await Effect.runPromiseExit(Effect.succeed({ sum: 10 }));
      return encodeLegacyExit(exit);
    });

    const client = createRpcClient(contract, {
      invoke,
      rpcDecodeMode: "envelope",
    });

    await expect(client.Add({ a: 4, b: 6 })).rejects.toThrow(/valid envelope/);
  });

  it("when client dual mode prefers envelope over legacy when both possible", async () => {
    const invoke = createInvokeStub(async () => ({
      type: "success",
      data: { sum: "wrong-type" },
      _tag: "Success",
      value: { sum: 999 },
    }));
    const decodeFailures: unknown[] = [];

    const client = createRpcClient(contract, {
      invoke,
      rpcDecodeMode: "dual",
      diagnostics: {
        onDecodeFailure: (context) => {
          decodeFailures.push(context);
        },
      },
    });

    await expect(client.Add({ a: 1, b: 2 })).rejects.toThrow(
      /success payload decoding failed/
    );
    expect(decodeFailures).toHaveLength(1);
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

  it("when client dual mode legacy failure throws typed error", async () => {
    const encodeLegacyExit = S.encodeUnknownSync(exitSchemaFor(MayFail));
    const invoke = createInvokeStub(async () => {
      const exit = await Effect.runPromiseExit(
        Effect.fail(new AccessDeniedError({ message: "denied-legacy" }))
      );
      return encodeLegacyExit(exit);
    });

    const client = createRpcClient(contract, {
      invoke,
      rpcDecodeMode: "dual",
    });

    await expect(client.MayFail()).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it("when client dual mode legacy defect throws RpcDefectError", async () => {
    const encodeLegacyExit = S.encodeUnknownSync(exitSchemaFor(Add));
    const invoke = createInvokeStub(async () => {
      const exit = await Effect.runPromiseExit(Effect.dieMessage("legacy-die"));
      return encodeLegacyExit(exit);
    });

    const client = createRpcClient(contract, {
      invoke,
      rpcDecodeMode: "dual",
    });

    await expect(client.Add({ a: 1, b: 2 })).rejects.toBeInstanceOf(RpcDefectError);
  });

  it("when client dual mode legacy interrupt throws RpcDefectError", async () => {
    const encodeLegacyExit = S.encodeUnknownSync(exitSchemaFor(Add));
    const invoke = createInvokeStub(async () => {
      const exit = await Effect.runPromiseExit(Effect.interrupt);
      return encodeLegacyExit(exit);
    });

    const client = createRpcClient(contract, {
      invoke,
      rpcDecodeMode: "dual",
    });

    await expect(client.Add({ a: 1, b: 2 })).rejects.toBeInstanceOf(RpcDefectError);
  });
});
