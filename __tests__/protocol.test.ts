import { describe, expect, it } from "bun:test";
import {
  extractErrorTag,
  parseRpcResponseEnvelope,
  safelyCall,
  toDefectEnvelope,
} from "../src/protocol.ts";

describe("protocol", () => {
  it("when protocol parse accepts valid success envelope", () => {
    const envelope = parseRpcResponseEnvelope({
      type: "success",
      data: { ok: true },
    });

    expect(envelope).toEqual({
      type: "success",
      data: { ok: true },
    });
  });

  it("when protocol parse accepts valid failure envelope", () => {
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

  it("when protocol parse accepts valid defect envelope", () => {
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

  it("when protocol parse rejects non object", () => {
    expect(parseRpcResponseEnvelope(null)).toBeNull();
    expect(parseRpcResponseEnvelope(42)).toBeNull();
    expect(parseRpcResponseEnvelope("oops")).toBeNull();
  });

  it("when protocol parse rejects missing required fields", () => {
    expect(parseRpcResponseEnvelope({ type: "success" })).toBeNull();
    expect(
      parseRpcResponseEnvelope({
        type: "failure",
        error: {
          tag: "X",
        },
      })
    ).toBeNull();
    expect(parseRpcResponseEnvelope({ type: "defect", cause: "x" })).toBeNull();
  });

  it("when protocol parse rejects unknown type", () => {
    expect(parseRpcResponseEnvelope({ type: "wat", data: {} })).toBeNull();
  });

  it("when protocol extractErrorTag prefers tagged error tag", () => {
    expect(extractErrorTag({ _tag: "TaggedDomainError", message: "x" })).toBe(
      "TaggedDomainError"
    );
  });

  it("when protocol extractErrorTag falls back to error name", () => {
    const error = new TypeError("nope");
    expect(extractErrorTag(error)).toBe("TypeError");
  });

  it("when protocol extractErrorTag defaults to RpcError", () => {
    expect(extractErrorTag({ message: "x" })).toBe("RpcError");
    expect(extractErrorTag(undefined)).toBe("RpcError");
  });

  it("when protocol toDefectEnvelope formats error and non error causes", () => {
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

  it("when protocol safelyCall swallows callback errors", () => {
    let callCount = 0;

    expect(() =>
      safelyCall(() => {
        callCount += 1;
        throw new Error("diagnostics blew up");
      }, { scope: "test" })
    ).not.toThrow();

    expect(callCount).toBe(1);
  });
});
