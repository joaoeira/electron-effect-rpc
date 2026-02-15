import { describe, expect, it } from "bun:test";
import * as S from "@effect/schema/Schema";
import { Cause, Effect, Exit } from "effect";
import { defineContract, exitSchemaFor, rpc } from "../src/contract.ts";
import { createRpcClient, RpcDefectError } from "../src/renderer.ts";
import { createInvokeStub } from "../src/testing.ts";

class AccessDeniedError extends S.TaggedError<AccessDeniedError>()(
  "AccessDeniedError",
  {
    message: S.String,
  }
) {}

function expectFailure<E>(exit: Exit.Exit<unknown, E>): E {
  if (Exit.isSuccess(exit)) {
    throw new Error("Expected exit failure.");
  }

  const failure = Cause.failureOption(exit.cause);
  if (failure._tag !== "Some") {
    throw new Error("Expected a regular failure in Cause.");
  }

  return failure.value;
}

function expectRpcDefect<E>(
  exit: Exit.Exit<unknown, E>
): RpcDefectError {
  const failure = expectFailure(exit as Exit.Exit<unknown, RpcDefectError>);
  expect(failure).toBeInstanceOf(RpcDefectError);
  return failure as RpcDefectError;
}

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

  it("when rpc client is created without an invoke function, then creation throws", () => {
    const createWithoutOptions = createRpcClient as unknown as (
      c: typeof contract,
      options?: unknown
    ) => unknown;

    expect(() => createWithoutOptions(contract)).toThrow(
      /RpcClientOptions.invoke is required/
    );
  });

  it("when a call succeeds, then the client encodes the request and decodes the success envelope", async () => {
    const invoke = createInvokeStub(async () => ({
      type: "success",
      data: { sum: 3 },
    }));

    const client = createRpcClient(contract, { invoke });
    const result = await Effect.runPromise(client.Add({ a: 1, b: 2 }));

    expect(result).toEqual({ sum: 3 });
    expect(invoke.invocations).toEqual([
      {
        method: "Add",
        payload: { a: 1, b: 2 },
      },
    ]);
  });

  it("when a method name contains special characters, then the client invokes that exact method name", async () => {
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
    await Effect.runPromise(client["system/get.version"]());

    expect(invoke.invocations).toEqual([
      {
        method: "system/get.version",
        payload: {},
      },
    ]);
  });

  it("when a request schema is empty, then the client allows zero-argument calls", async () => {
    const invoke = createInvokeStub(async () => ({
      type: "success",
      data: { ok: true },
    }));

    const client = createRpcClient(contract, { invoke });
    const result = await Effect.runPromise(client.Ping());

    expect(result).toEqual({ ok: true });
    expect(invoke.invocations).toEqual([
      {
        method: "Ping",
        payload: {},
      },
    ]);
  });

  it("when null is passed explicitly, then the client forwards null instead of substituting an empty object", async () => {
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
    const result = await Effect.runPromise(client.AcceptNull(null));

    expect(result).toEqual({ ok: true });
    expect(invoke.invocations).toEqual([
      {
        method: "AcceptNull",
        payload: null,
      },
    ]);
  });

  it("when a failure envelope contains a typed error, then the client fails with that typed error", async () => {
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
    const exit = await Effect.runPromiseExit(client.MayFail());
    const failure = expectFailure(exit);

    expect(failure).toBeInstanceOf(AccessDeniedError);
    if (failure instanceof AccessDeniedError) {
      expect(failure.message).toBe("denied");
    }
  });

  it("when a NoError method receives a failure envelope, then the client fails with a defect", async () => {
    const invoke = createInvokeStub(async () => ({
      type: "failure",
      error: {
        tag: "DomainError",
        data: { _tag: "DomainError", message: "nope" },
      },
    }));

    const client = createRpcClient(contract, { invoke });
    const exit = await Effect.runPromiseExit(client.Add({ a: 1, b: 2 }));
    const defect = expectRpcDefect(exit);

    expect(defect.code).toBe("noerror_contract_violation");
    expect(defect.message).toContain("declares NoError");
  });

  it("when a defect envelope is returned, then the client fails with RpcDefectError", async () => {
    const invoke = createInvokeStub(async () => ({
      type: "defect",
      message: "boom",
      cause: "boom",
    }));

    const client = createRpcClient(contract, { invoke });
    const exit = await Effect.runPromiseExit(client.Add({ a: 1, b: 2 }));
    const defect = expectRpcDefect(exit);

    expect(defect.code).toBe("remote_defect");
    expect(defect.message).toBe("boom");
    expect(defect.cause).toBe("boom");
  });

  it("when invoke returns a malformed response envelope, then the client reports a protocol error", async () => {
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

    const exit = await Effect.runPromiseExit(client.Add({ a: 1, b: 2 }));
    const defect = expectRpcDefect(exit);
    expect(defect.code).toBe("invalid_response_envelope");
    expect(defect.message).toContain("valid envelope");

    expect(protocolErrors.length).toBe(1);
    expect(protocolErrors[0]).toMatchObject({
      method: "Add",
      response: malformed,
    });
  });

  it("when a protocol error is reported, then diagnostics include the raw response payload", async () => {
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

    const exit = await Effect.runPromiseExit(client.Add({ a: 1, b: 2 }));
    const defect = expectRpcDefect(exit);
    expect(defect.code).toBe("invalid_response_envelope");
    expect(protocolErrors).toHaveLength(1);
    expect(protocolErrors[0]).toMatchObject({
      method: "Add",
      response: rawResponse,
    });
  });

  it("when success payload decoding fails, then the client reports decode-failure diagnostics", async () => {
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

    const exit = await Effect.runPromiseExit(client.Add({ a: 1, b: 2 }));
    const defect = expectRpcDefect(exit);
    expect(defect.code).toBe("success_payload_decoding_failed");
    expect(decodeFailures).toHaveLength(1);
    expect(decodeFailures[0]).toMatchObject({
      scope: "rpc-response",
      name: "Add",
      payload: { sum: "wrong-type" },
    });
  });

  it("when failure payload decoding fails, then the client reports decode-failure diagnostics", async () => {
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

    const exit = await Effect.runPromiseExit(client.MayFail());
    const defect = expectRpcDefect(exit);
    expect(defect.code).toBe("failure_payload_decoding_failed");
    expect(decodeFailures).toHaveLength(1);
    expect(decodeFailures[0]).toMatchObject({
      scope: "rpc-response",
      name: "MayFail",
    });
  });

  it("when decode-failure diagnostics are emitted, then their context shape is stable", async () => {
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

    const exit = await Effect.runPromiseExit(client.Add({ a: 1, b: 2 }));
    expectRpcDefect(exit);
    expect(decodeFailures).toHaveLength(1);
    expect(decodeFailures[0]).toMatchObject({
      scope: "rpc-response",
      name: "Add",
      payload: { sum: "wrong-type" },
    });
    expect(typeof decodeFailures[0]?.cause).not.toBe("undefined");
  });

  it("when protocol-error diagnostics are emitted, then their context shape is stable", async () => {
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

    const exit = await Effect.runPromiseExit(client.Add({ a: 1, b: 2 }));
    expectRpcDefect(exit);
    expect(protocolErrors).toHaveLength(1);
    expect(protocolErrors[0]).toMatchObject({
      method: "Add",
      response: malformed,
    });
    expect(typeof protocolErrors[0]?.cause).not.toBe("undefined");
  });

  it("when a diagnostics callback throws, then rpc transport behavior still completes", async () => {
    const invoke = createInvokeStub(async () => ({ nope: true }));
    const client = createRpcClient(contract, {
      invoke,
      diagnostics: {
        onProtocolError: () => {
          throw new Error("diagnostics crashed");
        },
      },
    });

    const exit = await Effect.runPromiseExit(client.Add({ a: 1, b: 2 }));
    const defect = expectRpcDefect(exit);
    expect(defect.code).toBe("invalid_response_envelope");
  });

  it("when invoke rejects, then the client reports a protocol error and fails with RpcDefectError", async () => {
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

    const exit = await Effect.runPromiseExit(client.Add({ a: 1, b: 2 }));
    const defect = expectRpcDefect(exit);

    expect(defect.code).toBe("invoke_failed");
    expect(defect.message).toContain("invoke failed");
    expect(defect.cause).toBeInstanceOf(Error);
    expect(protocolErrors.length).toBe(1);
  });

  it("when a call succeeds, then failure diagnostics are not emitted", async () => {
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

    const result = await Effect.runPromise(client.Add({ a: 3, b: 5 }));
    expect(result).toEqual({ sum: 8 });
    expect(decodeFailures).toEqual([]);
    expect(protocolErrors).toEqual([]);
  });

  it("when undefined is passed explicitly, then the client forwards undefined", async () => {
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
      ) => Effect.Effect<{ ok: boolean }, RpcDefectError>;
    const result = await Effect.runPromise(acceptUndefined(undefined));

    expect(result).toEqual({ ok: true });
    expect(invoke.invocations).toEqual([
      {
        method: "AcceptUndefined",
        payload: undefined,
      },
    ]);
  });

  it("when input is omitted for a non-empty schema, then request encoding fails in the defect channel", async () => {
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
      client.AcceptNull as unknown as () => Effect.Effect<
        { ok: boolean },
        RpcDefectError
      >;

    const exit = await Effect.runPromiseExit(noArgCaller());
    const defect = expectRpcDefect(exit);
    expect(defect.code).toBe("request_encoding_failed");
    expect(defect.message).toContain("Expected null, actual {}");
    expect(invoke.invocations).toEqual([]);
  });

  it("when decode mode is envelope and response is legacy Exit, then the client fails it as invalid envelope", async () => {
    const encodeLegacyExit = S.encodeUnknownSync(exitSchemaFor(Add));
    const invoke = createInvokeStub(async () => {
      const exit = await Effect.runPromiseExit(Effect.succeed({ sum: 10 }));
      return encodeLegacyExit(exit);
    });

    const client = createRpcClient(contract, {
      invoke,
      rpcDecodeMode: "envelope",
    });

    const exit = await Effect.runPromiseExit(client.Add({ a: 4, b: 6 }));
    const defect = expectRpcDefect(exit);
    expect(defect.code).toBe("invalid_response_envelope");
  });

  it("when decode mode is dual and both formats are present, then the envelope format takes precedence", async () => {
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

    const exit = await Effect.runPromiseExit(client.Add({ a: 1, b: 2 }));
    const defect = expectRpcDefect(exit);
    expect(defect.code).toBe("success_payload_decoding_failed");
    expect(decodeFailures).toHaveLength(1);
  });

  it("when decode mode is dual and response is legacy Exit, then the client decodes the legacy response", async () => {
    const encodeLegacyExit = S.encodeUnknownSync(exitSchemaFor(Add));

    const invoke = createInvokeStub(async () => {
      const exit = await Effect.runPromiseExit(Effect.succeed({ sum: 10 }));
      return encodeLegacyExit(exit);
    });

    const client = createRpcClient(contract, {
      invoke,
      rpcDecodeMode: "dual",
    });

    const result = await Effect.runPromise(client.Add({ a: 4, b: 6 }));
    expect(result).toEqual({ sum: 10 });
  });

  it("when decode mode is dual and legacy response is a typed failure, then the client fails with the typed error", async () => {
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

    const exit = await Effect.runPromiseExit(client.MayFail());
    const failure = expectFailure(exit);
    expect(failure).toBeInstanceOf(AccessDeniedError);
    if (failure instanceof AccessDeniedError) {
      expect(failure.message).toBe("denied-legacy");
    }
  });

  it("when decode mode is dual and legacy response is a defect, then the client fails with RpcDefectError", async () => {
    const encodeLegacyExit = S.encodeUnknownSync(exitSchemaFor(Add));
    const invoke = createInvokeStub(async () => {
      const exit = await Effect.runPromiseExit(Effect.dieMessage("legacy-die"));
      return encodeLegacyExit(exit);
    });

    const client = createRpcClient(contract, {
      invoke,
      rpcDecodeMode: "dual",
    });

    const exit = await Effect.runPromiseExit(client.Add({ a: 1, b: 2 }));
    const defect = expectRpcDefect(exit);
    expect(defect.code).toBe("remote_defect");
    expect(defect.message).toContain("legacy-die");
  });

  it("when decode mode is dual and legacy response is an interrupt, then the client fails with RpcDefectError", async () => {
    const encodeLegacyExit = S.encodeUnknownSync(exitSchemaFor(Add));
    const invoke = createInvokeStub(async () => {
      const exit = await Effect.runPromiseExit(Effect.interrupt);
      return encodeLegacyExit(exit);
    });

    const client = createRpcClient(contract, {
      invoke,
      rpcDecodeMode: "dual",
    });

    const exit = await Effect.runPromiseExit(client.Add({ a: 1, b: 2 }));
    const defect = expectRpcDefect(exit);
    expect(defect.code).toBe("remote_defect");
    expect(defect.message).toContain("interrupted");
  });
});
