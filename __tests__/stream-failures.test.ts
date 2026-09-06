import { describe, expect, it } from "bun:test";
import { Cause, Context, Deferred, Effect, Exit, Stream } from "effect";
import * as S from "effect/Schema";
import { defineContract, event, streamRpc } from "../src/contract.ts";
import { createRpcEndpoint } from "../src/main.ts";
import { parseStreamFrame } from "../src/protocol.ts";
import { createEventSubscriber, createStreamRpcClient } from "../src/renderer.ts";
import type { IpcEncodedValue, ProtocolErrorContext } from "../src/types.ts";
import type { IpcTestListener } from "./test-support.ts";

describe("stream failure propagation", () => {
  it("fails the event consumer with the original subscription setup defect", async () => {
    const Progress = event("Progress", S.Number);
    const contract = defineContract({ methods: [], events: [Progress] });
    const defect = new Error("subscription setup failed");
    const subscriber = createEventSubscriber(contract, {
      subscribe: () => {
        throw defect;
      },
    });
    try {
      const exit = await Effect.runPromiseExit(
        subscriber.stream(Progress).pipe(Stream.runDrain, Effect.timeout("1 second")),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.findDefect(exit.cause)).toMatchObject({ success: defect });
      }
    } finally {
      subscriber.dispose();
    }
  });

  it.each(["encoding", "sending", "terminal sending"])(
    "reports %s failure and finalizes the main stream",
    async (failure) => {
      const Numbers = streamRpc("Numbers", S.Struct({}), S.Number.check(S.isGreaterThan(0)));
      const contract = defineContract({ methods: [], events: [], streamMethods: [Numbers] });
      const handlers = new Map<string, IpcTestListener>();
      const finalized = Deferred.makeUnsafe<void>();
      const frames: IpcEncodedValue[] = [];
      const diagnostics: ProtocolErrorContext[] = [];
      const sendFailure = new Error("send failed");
      let produced = 0;
      const endpoint = createRpcEndpoint(
        contract,
        {
          handle: (name, handler) => {
            handlers.set(name, handler);
          },
          removeHandler: (name) => {
            handlers.delete(name);
          },
        },
        {},
        {
          context: Context.empty(),
          streamHandlers: {
            Numbers: () =>
              Stream.fromIterable(failure === "encoding" ? [-1, 2] : [1, 2]).pipe(
                Stream.mapEffect((value) =>
                  Effect.sync(() => {
                    produced++;
                    return value;
                  }),
                ),
              ),
          },
          diagnostics: {
            onProtocolError: (context) => {
              diagnostics.push(context);
            },
          },
        },
      );
      endpoint.start();
      try {
        const handler = handlers.get("rpc/stream/Numbers");
        if (!handler) throw new Error("stream handler missing");
        await handler(
          {
            sender: {
              id: 1,
              isDestroyed: () => false,
              send: (_channel, payload) => {
                const frame = parseStreamFrame(payload);
                if (
                  (failure === "sending" && frame?.type === "data") ||
                  (failure === "terminal sending" && frame?.type === "end")
                )
                  throw sendFailure;
                frames.push(payload);
              },
              once: () => {},
              removeListener: () => {
                Deferred.doneUnsafe(finalized, Exit.void);
              },
            },
          },
          { streamId: "failure-test", data: {} },
        );
        await Effect.runPromise(Deferred.await(finalized));

        if (failure === "terminal sending") {
          expect(produced).toBe(2);
          expect(diagnostics).toHaveLength(1);
          expect(diagnostics[0]).toMatchObject({
            method: "Numbers",
            response: { type: "end", streamId: "failure-test" },
            cause: sendFailure,
          });
        } else {
          expect(produced).toBe(1);
          expect(frames).toHaveLength(1);
          expect(frames[0]).toMatchObject({ type: "defect", streamId: "failure-test" });
          if (failure === "sending") expect(frames[0]).toMatchObject({ message: "send failed" });
        }
        const cancel = handlers.get("rpc/stream-cancel");
        if (!cancel) throw new Error("cancel handler missing");
        expect(
          await cancel(
            { sender: { id: 1, isDestroyed: () => false, send: () => {} } },
            { streamId: "failure-test" },
          ),
        ).toEqual({ cancelled: false });
      } finally {
        endpoint.dispose();
      }
    },
  );

  it.each([false, true])(
    "reports cancellation failure without breaking consumer cleanup (diagnostic throws: %s)",
    async (diagnosticThrows) => {
      const Numbers = streamRpc("Numbers", S.Struct({}), S.Number);
      const contract = defineContract({ methods: [], events: [], streamMethods: [Numbers] });
      const listeners = new Set<(frame: IpcEncodedValue) => void>();
      const diagnostics: ProtocolErrorContext[] = [];
      const cancelFailure = new Error("cancel transport failed");
      let cancelCalls = 0;
      const handle = createStreamRpcClient(contract, {
        onStreamFrame: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        invoke: async (method, payload) => {
          if (method === "stream-cancel") {
            cancelCalls++;
            throw cancelFailure;
          }
          if (!S.is(S.Struct({ streamId: S.String }))(payload)) throw new Error("missing streamId");
          for (const listener of listeners) {
            listener({ type: "data", streamId: payload.streamId, payload: 1 });
          }
          return { type: "success", data: { type: "stream_started" } };
        },
        diagnostics: {
          onProtocolError: (context) => {
            diagnostics.push(context);
            if (diagnosticThrows) throw new Error("diagnostics failed");
          },
        },
      });
      try {
        expect(
          await Effect.runPromise(handle.client.Numbers().pipe(Stream.take(1), Stream.runCollect)),
        ).toEqual([1]);
        expect(cancelCalls).toBe(1);
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]).toMatchObject({
          method: "stream-cancel/Numbers",
          cause: cancelFailure,
        });
      } finally {
        handle.dispose();
      }
      expect(listeners.size).toBe(0);
    },
  );
});
