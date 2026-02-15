import * as S from "@effect/schema/Schema";
import { Effect } from "effect";
import type * as Fx from "effect/Effect";
import * as Runtime from "effect/Runtime";
import { createIpcKit, defineContract, event, rpc } from "../src/index.ts";
import type { IpcMainLike, RpcDefectError } from "../src/types.ts";

const Ping = rpc("Ping", S.Struct({}), S.Struct({ ok: S.Boolean }));
const Echo = rpc(
  "Echo",
  S.Struct({ message: S.String }),
  S.Struct({ echoed: S.String })
);
const Progress = event("Progress", S.Struct({ value: S.Number }));

const contract = defineContract({
  methods: [Ping, Echo] as const,
  events: [Progress] as const,
});

const kit = createIpcKit({
  contract,
});

const bridge = {
  invoke: async (method: string) => {
    if (method === "Ping") {
      return {
        type: "success",
        data: {
          ok: true,
        },
      };
    }

    return {
      type: "success",
      data: {
        echoed: "ok",
      },
    };
  },
  subscribe: () => () => {},
};

const { client, events } = kit.renderer(bridge);
const pingEffect: Fx.Effect<{ ok: boolean }, RpcDefectError> = client.Ping();
const echoEffect: Fx.Effect<{ echoed: string }, RpcDefectError> = client.Echo({
  message: "hello",
});
void pingEffect;
void echoEffect;
// @ts-expect-error Non-empty request must be provided.
client.Echo();

events.subscribe(Progress, (payload) => {
  const value: number = payload.value;
  void value;
});
events.subscribe(Progress, (payload) => {
  // @ts-expect-error Progress payload value is number.
  const wrong: string = payload.value;
  void wrong;
});

const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
const ipcMainStub: IpcMainLike = {
  handle: (channel, listener) => {
    handlers.set(channel, listener);
  },
  removeHandler: (channel) => {
    handlers.delete(channel);
  },
};

const mainOk = kit.main({
  ipcMain: ipcMainStub,
  handlers: {
    Ping: () => Effect.succeed({ ok: true }),
    Echo: ({ message }) => Effect.succeed({ echoed: message }),
  },
  runtime: Runtime.defaultRuntime,
  getWindow: () => null,
});

const publishEffect: Fx.Effect<void, never> = mainOk.publish(Progress, {
  value: 1,
});
void publishEffect;

kit.main({
  ipcMain: ipcMainStub,
  // @ts-expect-error Missing Echo handler.
  handlers: {
    Ping: () => Effect.succeed({ ok: true }),
  },
  runtime: Runtime.defaultRuntime,
  getWindow: () => null,
});

kit.main({
  ipcMain: ipcMainStub,
  handlers: {
    Ping: () => Effect.succeed({ ok: true }),
    Echo: ({ message }) => Effect.succeed({ echoed: message }),
    // @ts-expect-error Extra handler key should be rejected.
    Extra: () => Effect.succeed({ ok: true }),
  },
  runtime: Runtime.defaultRuntime,
  getWindow: () => null,
});
