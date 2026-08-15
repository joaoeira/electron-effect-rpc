import * as S from "effect/Schema";
import { Effect } from "effect";
import type * as Fx from "effect/Effect";
import * as ContextModule from "effect/Context";
import { createIpcKit, defineContract, event, rpc } from "../src/index.ts";
import type { IpcMainLike, RpcDefectError } from "../src/types.ts";

const Ping = rpc("Ping", S.Struct({}), S.Struct({ ok: S.Boolean }));
const Echo = rpc("Echo", S.Struct({ message: S.String }), S.Struct({ echoed: S.String }));
const Progress = event("Progress", S.Struct({ value: S.Number }));

const contract = defineContract({
  methods: [Ping, Echo] as const,
  events: [Progress] as const,
});

const kit = createIpcKit({
  contract,
});

const kitWithStreamBuffer = createIpcKit({
  contract,
  streamBuffer: {
    bufferSize: "unbounded",
  },
});
void kitWithStreamBuffer;

createIpcKit({
  contract,
  streamBuffer: {
    // @ts-expect-error Unsupported stream buffer strategy.
    strategy: "suspend",
    bufferSize: 32,
  },
});

createIpcKit({
  contract,
  // @ts-expect-error Bounded buffer requires both bufferSize and strategy.
  streamBuffer: {},
});

createIpcKit({
  contract,
  // @ts-expect-error Bounded buffer requires strategy.
  streamBuffer: {
    bufferSize: 32,
  },
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
const preloadHandle = kit.preload();
const preloadGlobal: string = preloadHandle.global;
const preloadExpose: () => void = preloadHandle.expose;
void preloadGlobal;
void preloadExpose;

const preloadWithElectronModule = kit.preload({
  electronModule: {},
});
void preloadWithElectronModule;

type AssertSync<T> = T extends Promise<unknown> ? never : T;
const preloadReturnIsSync: AssertSync<ReturnType<typeof kit.preload>> = preloadHandle;
void preloadReturnIsSync;

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
  context: ContextModule.empty(),
  getWindows: () => [],
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
  context: ContextModule.empty(),
  getWindows: () => [],
});

kit.main({
  ipcMain: ipcMainStub,
  handlers: {
    Ping: () => Effect.succeed({ ok: true }),
    Echo: ({ message }) => Effect.succeed({ echoed: message }),
    // @ts-expect-error Extra handler key should be rejected.
    Extra: () => Effect.succeed({ ok: true }),
  },
  context: ContextModule.empty(),
  getWindows: () => [],
});
