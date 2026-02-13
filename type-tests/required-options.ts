import * as S from "@effect/schema/Schema";
import { defineContract, event, rpc } from "../src/contract.ts";
import { createEventSubscriber, createRpcClient } from "../src/renderer.ts";

const Ping = rpc("Ping", S.Struct({}), S.Struct({ ok: S.Boolean }));
const Progress = event("Progress", S.Struct({ value: S.Number }));

const contract = defineContract({
  methods: [Ping] as const,
  events: [Progress] as const,
});

createRpcClient(contract, {
  invoke: async () => ({
    type: "success",
    data: {
      ok: true,
    },
  }),
});

// @ts-expect-error invoke is required.
createRpcClient(contract);

createEventSubscriber(contract, {
  subscribe: () => () => {},
});

// @ts-expect-error subscribe is required.
createEventSubscriber(contract);
