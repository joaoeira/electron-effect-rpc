import { describe, it, expect } from "bun:test";
import * as S from "@effect/schema/Schema";
import { defineContract, event, rpc } from "../src/contract.ts";

const EmptyRequest = S.Struct({});
const EmptyResponse = S.Struct({});
const EmptyEventPayload = S.Struct({});

const FooMethod = rpc("Foo", EmptyRequest, EmptyResponse);
const BarEvent = event("Bar", EmptyEventPayload);

describe("defineContract", () => {
  it("when methods and events are both empty, then defineContract returns an empty contract", () => {
    const contract = defineContract({
      methods: [] as const,
      events: [] as const,
    });

    expect(contract.methods).toEqual([]);
    expect(contract.events).toEqual([]);
  });

  it("when methods and events are provided in order, then defineContract preserves that order", () => {
    const FirstMethod = rpc("First", S.Struct({}), S.Struct({}));
    const SecondMethod = rpc("Second", S.Struct({}), S.Struct({}));
    const FirstEvent = event("FirstEvent", S.Struct({}));
    const SecondEvent = event("SecondEvent", S.Struct({}));

    const contract = defineContract({
      methods: [FirstMethod, SecondMethod] as const,
      events: [FirstEvent, SecondEvent] as const,
    });

    expect(contract.methods.map((method) => method.name)).toEqual([
      "First",
      "Second",
    ]);
    expect(contract.events.map((ev) => ev.name)).toEqual([
      "FirstEvent",
      "SecondEvent",
    ]);
  });

  it("when entries share shape but have distinct names, then defineContract accepts them", () => {
    const Alpha = rpc("Alpha", S.Struct({ value: S.Number }), S.Struct({ ok: S.Boolean }));
    const Beta = rpc("Beta", S.Struct({ value: S.Number }), S.Struct({ ok: S.Boolean }));
    const Tick = event("Tick", S.Struct({ value: S.Number }));
    const Tock = event("Tock", S.Struct({ value: S.Number }));

    const contract = defineContract({
      methods: [Alpha, Beta] as const,
      events: [Tick, Tock] as const,
    });

    expect(contract.methods).toHaveLength(2);
    expect(contract.events).toHaveLength(2);
  });

  it("when two methods share the same name, then defineContract throws", () => {
    expect(() =>
      defineContract({ methods: [FooMethod, FooMethod], events: [] })
    ).toThrow(/Duplicate RPC method name/);
  });

  it("when two events share the same name, then defineContract throws", () => {
    expect(() =>
      defineContract({ methods: [FooMethod], events: [BarEvent, BarEvent] })
    ).toThrow(/Duplicate RPC event name/);
  });

  it("when methods or events are not arrays, then defineContract throws", () => {
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
