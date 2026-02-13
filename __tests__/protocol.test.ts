import { describe, expect, it } from "bun:test";
import {
  extractErrorTag,
  parseRpcResponseEnvelope,
  safelyCall,
  toDefectEnvelope,
} from "../src/protocol.ts";

describe("protocol", () => {
  it("protocol_parse_accepts_valid_success_envelope", () => {
    const envelope = parseRpcResponseEnvelope({
      type: "success",
      data: { ok: true },
    });

    expect(envelope).toEqual({
      type: "success",
      data: { ok: true },
    });
  });

  it("protocol_parse_accepts_valid_failure_envelope", () => {
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

  it("protocol_parse_accepts_valid_defect_envelope", () => {
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

  it("protocol_parse_rejects_non_object", () => {
    expect(parseRpcResponseEnvelope(null)).toBeNull();
    expect(parseRpcResponseEnvelope(42)).toBeNull();
    expect(parseRpcResponseEnvelope("oops")).toBeNull();
  });

  it("protocol_parse_rejects_missing_required_fields", () => {
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

  it("protocol_parse_rejects_unknown_type", () => {
    expect(parseRpcResponseEnvelope({ type: "wat", data: {} })).toBeNull();
  });

  it("protocol_extractErrorTag_prefers_tagged_error_tag", () => {
    expect(extractErrorTag({ _tag: "TaggedDomainError", message: "x" })).toBe(
      "TaggedDomainError"
    );
  });

  it("protocol_extractErrorTag_falls_back_to_error_name", () => {
    const error = new TypeError("nope");
    expect(extractErrorTag(error)).toBe("TypeError");
  });

  it("protocol_extractErrorTag_defaults_to_RpcError", () => {
    expect(extractErrorTag({ message: "x" })).toBe("RpcError");
    expect(extractErrorTag(undefined)).toBe("RpcError");
  });

  it("protocol_toDefectEnvelope_formats_error_and_non_error_causes", () => {
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

  it("protocol_safelyCall_swallows_callback_errors", () => {
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
