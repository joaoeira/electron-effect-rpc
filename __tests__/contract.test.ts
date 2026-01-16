import { describe, it, expect } from "bun:test";
import * as S from "@effect/schema/Schema";
import { defineContract, event, rpc } from "../src/contract.ts";

const EmptyRequest = S.Struct({});
const EmptyResponse = S.Struct({});
const EmptyEventPayload = S.Struct({});

const FooMethod = rpc("Foo", EmptyRequest, EmptyResponse);
const BarEvent = event("Bar", EmptyEventPayload);

describe("defineContract", () => {
  it("throws on duplicate method names", () => {
    expect(() =>
      defineContract({ methods: [FooMethod, FooMethod], events: [] })
    ).toThrow(/Duplicate RPC method name/);
  });

  it("throws on duplicate event names", () => {
    expect(() =>
      defineContract({ methods: [FooMethod], events: [BarEvent, BarEvent] })
    ).toThrow(/Duplicate RPC event name/);
  });

  it("throws when methods or events are not arrays", () => {
    // @ts-expect-error runtime validation for invalid shape
    expect(() => defineContract({ methods: "nope", events: [] })).toThrow(
      /methods must be an array/
    );
    // @ts-expect-error runtime validation for invalid shape
    expect(() => defineContract({ methods: [], events: "nope" })).toThrow(
      /events must be an array/
    );
  });
});
