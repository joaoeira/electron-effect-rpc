import { describe, expect, it } from "bun:test";
import { toDiagnosticCause } from "../src/boundary.ts";
import {
  extractErrorTag,
  parseRpcResponseEnvelope,
  parseStreamFrame,
  safelyCall,
  toDefectEnvelope,
} from "../src/protocol.ts";

describe("protocol", () => {
  it("when a success envelope has the required shape, then parser returns a success envelope", () => {
    const envelope = parseRpcResponseEnvelope({
      type: "success",
      data: { ok: true },
    });

    expect(envelope).toEqual({
      type: "success",
      data: { ok: true },
    });
  });

  it("when an envelope carries a BigInt payload, then parser preserves the structured-clone value", () => {
    const envelope = parseRpcResponseEnvelope({
      type: "success",
      data: 9007199254740993n,
    });

    expect(envelope).toEqual({
      type: "success",
      data: 9007199254740993n,
    });
  });

  it("when a stream frame carries a BigInt payload, then parser preserves the structured-clone value", () => {
    const frame = parseStreamFrame({
      type: "data",
      streamId: "bigint-stream",
      payload: 9007199254740993n,
    });

    expect(frame).toEqual({
      type: "data",
      streamId: "bigint-stream",
      payload: 9007199254740993n,
    });
  });

  it("when an envelope carries a cyclic payload, then parsing and diagnostics remain safe", () => {
    type CyclicPayload = { self?: CyclicPayload };
    const payload: CyclicPayload = {};
    payload.self = payload;

    const envelope = parseRpcResponseEnvelope({ type: "success", data: payload });

    expect(envelope?.type).toBe("success");
    if (envelope?.type === "success") {
      expect(envelope.data).toBe(payload);
    }
    expect(toDiagnosticCause(payload)).toBe(payload);
  });

  it("when a failure envelope has the required shape, then parser returns a failure envelope", () => {
    const envelope = parseRpcResponseEnvelope({
      type: "failure",
      error: {
        tag: "DomainError",
        data: { message: "denied" },
      },
    });

    expect(envelope).toEqual({
      type: "failure",
      error: {
        tag: "DomainError",
        data: { message: "denied" },
      },
    });
  });

  it("when a defect envelope has the required shape, then parser returns a defect envelope", () => {
    const envelope = parseRpcResponseEnvelope({
      type: "defect",
      message: "boom",
      cause: "boom",
    });

    expect(envelope).toEqual({
      type: "defect",
      message: "boom",
      cause: "boom",
    });
  });

  it("when response input is not an object, then parser returns null", () => {
    expect(parseRpcResponseEnvelope(null)).toBeNull();
    expect(parseRpcResponseEnvelope(42)).toBeNull();
    expect(parseRpcResponseEnvelope("oops")).toBeNull();
  });

  it("when required envelope fields are missing, then parser returns null", () => {
    expect(parseRpcResponseEnvelope({ type: "success" })).toBeNull();
    expect(
      parseRpcResponseEnvelope({
        type: "failure",
        error: {
          tag: "X",
        },
      }),
    ).toBeNull();
    expect(parseRpcResponseEnvelope({ type: "defect", cause: "x" })).toBeNull();
  });

  it("when envelope type is unknown, then parser returns null", () => {
    expect(parseRpcResponseEnvelope({ type: "wat", data: {} })).toBeNull();
  });

  it("when error has a _tag field, then extractErrorTag returns that tag", () => {
    expect(extractErrorTag({ _tag: "TaggedDomainError", message: "x" })).toBe("TaggedDomainError");
  });

  it("when error has no _tag but is an Error instance, then extractErrorTag returns error.name", () => {
    const error = new TypeError("nope");
    expect(extractErrorTag(error)).toBe("TypeError");
  });

  it("when no tag or Error name is available, then extractErrorTag returns RpcError", () => {
    expect(extractErrorTag({ message: "x" })).toBe("RpcError");
    expect(extractErrorTag(undefined)).toBe("RpcError");
  });

  it("when building a defect envelope from unknown causes, then message and cause are stringified consistently", () => {
    const fromError = toDefectEnvelope(new Error("broken"), "prefix");
    const fromValue = toDefectEnvelope(404, "prefix");

    expect(fromError).toEqual({
      type: "defect",
      message: "prefix: broken",
      cause: "broken",
    });
    expect(fromValue).toEqual({
      type: "defect",
      message: "prefix: 404",
      cause: "404",
    });
  });

  it("when diagnostics callback throws, then safelyCall swallows the exception", () => {
    let callCount = 0;

    expect(() =>
      safelyCall(
        () => {
          callCount += 1;
          throw new Error("diagnostics blew up");
        },
        { scope: "test" },
      ),
    ).not.toThrow();

    expect(callCount).toBe(1);
  });
});
