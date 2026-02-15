import { describe, expect, it } from "bun:test";
import * as S from "@effect/schema/Schema";
import { Effect } from "effect";
import * as Runtime from "effect/Runtime";
import { defineContract, event, rpc } from "../src/contract.ts";
import { createEventPublisher, createRpcEndpoint } from "../src/main.ts";
import { createRpcClient } from "../src/renderer.ts";
import type { IpcMainLike } from "../src/types.ts";

const waitFor = async (predicate: () => boolean, timeoutMs = 3000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
};

const createRpcHarness = () => {
  const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();

  const ipcMain: IpcMainLike = {
    handle: (channel, listener) => {
      handlers.set(channel, listener);
    },
    removeHandler: (channel) => {
      handlers.delete(channel);
    },
  };

  const invoke = async (method: string, payload: unknown) => {
    const handler = handlers.get(`rpc/${method}`);
    if (!handler) {
      throw new Error(`Missing handler for method: ${method}`);
    }
    return handler({}, payload);
  };

  return {
    ipcMain,
    invoke,
  };
};

describe("stress", () => {
  it("when rpc call volume is high, then responses stay isolated with no state corruption", async () => {
    const Add = rpc(
      "Add",
      S.Struct({ a: S.Number, b: S.Number }),
      S.Struct({ sum: S.Number })
    );
    const contract = defineContract({
      methods: [Add] as const,
      events: [] as const,
    });
    const { ipcMain, invoke } = createRpcHarness();

    const endpoint = createRpcEndpoint(contract, ipcMain, {
      Add: ({ a, b }) => Effect.succeed({ sum: a + b }),
    }, {
      runtime: Runtime.defaultRuntime,
    });
    endpoint.start();

    const client = createRpcClient(contract, { invoke });
    const total = 500;

    const results = await Promise.all(
      Array.from({ length: total }, async (_, i) => {
        const result = await Effect.runPromise(client.Add({ a: i, b: i * 2 }));
        return {
          index: i,
          sum: result.sum,
        };
      })
    );

    for (const result of results) {
      expect(result.sum).toBe(result.index * 3);
    }
  });

  it("when events burst faster than dispatch, then memory is bounded by maxQueue dropping behavior", async () => {
    const Progress = event("Progress", S.Struct({ value: S.Number }));
    const contract = defineContract({
      methods: [] as const,
      events: [Progress] as const,
    });

    const publisher = createEventPublisher(contract, {
      getWindow: () => null,
      maxQueueSize: 25,
    });

    for (let i = 0; i < 500; i += 1) {
      await Effect.runPromise(publisher.publish(Progress, { value: i }));
    }

    expect(publisher.stats()).toEqual({
      queued: 25,
      dropped: 475,
    });
  });

  it("when window availability flaps under load, then dropped-event accounting remains consistent", async () => {
    const Progress = event("Progress", S.Struct({ value: S.Number }));
    const contract = defineContract({
      methods: [] as const,
      events: [Progress] as const,
    });

    let windowRead = 0;
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const publisher = createEventPublisher(contract, {
      getWindow: () => {
        windowRead += 1;
        if (windowRead % 2 === 1) {
          return null;
        }
        return {
          isDestroyed: () => false,
          webContents: {
            send: (channel: string, payload: unknown) => {
              sent.push({ channel, payload });
            },
          },
        };
      },
    });

    publisher.start();
    const total = 200;
    for (let i = 0; i < total; i += 1) {
      await Effect.runPromise(publisher.publish(Progress, { value: i }));
    }

    await waitFor(() => publisher.stats().dropped + sent.length === total);

    expect(publisher.stats().queued).toBe(0);
    expect(publisher.stats().dropped + sent.length).toBe(total);
  });
});
