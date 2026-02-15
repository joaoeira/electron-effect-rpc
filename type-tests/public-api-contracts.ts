import * as S from "@effect/schema/Schema";
import { Effect } from "effect";
import { defineContract, event, rpc, type RpcError } from "../src/contract.ts";
import {
  NoError as RootNoError,
  createIpcKit,
  defineContract as defineContractRoot,
  event as eventRoot,
  rpc as rpcRoot,
} from "../src/index.ts";
import { createEventPublisher } from "../src/main.ts";
import { createEventSubscriber, createRpcClient } from "../src/renderer.ts";
import type {
  Implementations,
  RpcClient,
  RpcDefectError,
  RpcMethodError,
} from "../src/types.ts";
import type {
  IpcBridge,
  IpcBridgeGlobal,
  IpcKit,
  IpcKitOptions,
  IpcMainHandle,
} from "../src/index.ts";

class AccessDeniedError extends S.TaggedError<AccessDeniedError>()(
  "AccessDeniedError",
  {
    message: S.String,
  }
) {}

const EmptyReq = rpc("EmptyReq", S.Struct({}), S.String);
const NeedsReq = rpc("NeedsReq", S.Struct({ value: S.Number }), S.String);
const NullReq = rpc("NullReq", S.Null, S.String);
const NoErr = rpc("NoErr", S.Struct({}), S.String);
const WithErr = rpc("WithErr", S.Struct({}), S.String, AccessDeniedError);
const Progress = event("Progress", S.Struct({ value: S.Number, label: S.String }));

const contract = defineContract({
  methods: [EmptyReq, NeedsReq, NullReq, NoErr, WithErr] as const,
  events: [Progress] as const,
});

const invoke = async (_method: string, _payload: unknown) =>
  ({ type: "success", data: "ok" }) as const;
const client = createRpcClient(contract, { invoke });

const RootPing = rpcRoot("RootPing", S.Struct({}), S.Struct({ ok: S.Boolean }));
const rootContract = defineContractRoot({
  methods: [RootPing] as const,
  events: [] as const,
});
const rootKit = createIpcKit({ contract: rootContract });
void rootKit;
void RootNoError;

// rpcCaller_zero_arg_only_for_empty_object_requests
const emptyReqEffect: Effect.Effect<string, RpcDefectError> = client.EmptyReq();
void emptyReqEffect;
// @ts-expect-error Empty object request callers are zero-arg.
client.EmptyReq({});

// rpcCaller_requires_arg_for_non_empty_requests
const needsReqEffect: Effect.Effect<string, RpcDefectError> = client.NeedsReq({
  value: 1,
});
void needsReqEffect;
// @ts-expect-error Non-empty request must be provided.
client.NeedsReq();

// rpcCaller_accepts_null_when_schema_null
const nullReqEffect: Effect.Effect<string, RpcDefectError> = client.NullReq(null);
void nullReqEffect;
// @ts-expect-error Null request must not allow omitted input.
client.NullReq();

// rpcCaller_error_channels_are_explicit_effect_types
const noErrEffect: Effect.Effect<string, RpcDefectError> = client.NoErr();
const withErrEffect: Effect.Effect<
  string,
  RpcError<typeof WithErr> | RpcDefectError
> = client.WithErr();
void noErrEffect;
void withErrEffect;

// implementations_require_all_contract_methods
const implementationsOk: Implementations<typeof contract> = {
  EmptyReq: () => Effect.succeed("ok"),
  NeedsReq: ({ value }) => Effect.succeed(String(value)),
  NullReq: () => Effect.succeed("ok"),
  NoErr: () => Effect.succeed("ok"),
  WithErr: () => Effect.fail(new AccessDeniedError({ message: "denied" })),
};
void implementationsOk;

// implementations_reject_extra_keys
const implementationsExtra: Implementations<typeof contract> = {
  EmptyReq: () => Effect.succeed("ok"),
  NeedsReq: ({ value }) => Effect.succeed(String(value)),
  NullReq: () => Effect.succeed("ok"),
  NoErr: () => Effect.succeed("ok"),
  WithErr: () => Effect.fail(new AccessDeniedError({ message: "denied" })),
  // @ts-expect-error Extra implementation key should be rejected.
  Extra: () => Effect.succeed("extra"),
};
void implementationsExtra;

// @ts-expect-error Missing implementation key should be rejected.
const implementationsMissing: Implementations<typeof contract> = {
  EmptyReq: () => Effect.succeed("ok"),
  NeedsReq: ({ value }) => Effect.succeed(String(value)),
  NullReq: () => Effect.succeed("ok"),
  NoErr: () => Effect.succeed("ok"),
};
void implementationsMissing;

// rpcClient_method_names_match_contract_only
const typedClient: RpcClient<typeof contract> = client;
typedClient.EmptyReq();
// @ts-expect-error Method not in contract should not exist.
typedClient.NotInContract();

// event_subscriber_payload_inference_is_exact
const subscriber = createEventSubscriber(contract, {
  subscribe: () => () => {},
});
subscriber.subscribe(Progress, (payload) => {
  const value: number = payload.value;
  const label: string = payload.label;
  void value;
  void label;
});
subscriber.subscribe(Progress, (payload) => {
  // @ts-expect-error payload.value is number, not string.
  const wrong: string = payload.value;
  void wrong;
});

// event_publisher_payload_inference_is_exact
const publisher = createEventPublisher(contract, {
  getWindow: () => null,
});
publisher.publish(Progress, { value: 1, label: "progress" });
// @ts-expect-error Missing required "label" field.
publisher.publish(Progress, { value: 1 });
// @ts-expect-error Wrong type for "value" field.
publisher.publish(Progress, { value: "1", label: "progress" });

type Assert<T extends true> = T;
type IsNever<T> = [T] extends [never] ? true : false;
type IsEqual<A, B> = (<T>() => T extends A ? 1 : 2) extends (
  <T>() => T extends B ? 1 : 2
)
  ? true
  : false;
type ErrorOf<T> = T extends Effect.Effect<unknown, infer E, unknown> ? E : never;

// NoError_methods_have_never_error_channel
type _NoErrIsNever = Assert<IsNever<RpcError<typeof NoErr>>>;
type _WithErrIsNotNever = Assert<
  IsNever<RpcError<typeof WithErr>> extends false ? true : false
>;
void (0 as unknown as _NoErrIsNever);
void (0 as unknown as _WithErrIsNotNever);

// rpcMethodError_channel_contract
type _NoErrClientChannelIsDefectOnly = Assert<
  IsEqual<ErrorOf<ReturnType<typeof client.NoErr>>, RpcDefectError>
>;
type _WithErrClientChannelIsDomainPlusDefect = Assert<
  IsEqual<ErrorOf<ReturnType<typeof client.WithErr>>, RpcMethodError<typeof WithErr>>
>;
void (0 as unknown as _NoErrClientChannelIsDefectOnly);
void (0 as unknown as _WithErrClientChannelIsDomainPlusDefect);

type _RootSmokeTypes = {
  bridge: IpcBridge;
  bridgeGlobal: IpcBridgeGlobal<"api">;
  kit: IpcKit<typeof rootContract>;
  kitOptions: IpcKitOptions<typeof rootContract>;
  mainHandle: IpcMainHandle<typeof rootContract>;
};
void (0 as unknown as _RootSmokeTypes);
void eventRoot;

type RootModule = typeof import("../src/index.ts");
// @ts-expect-error Low-level factories stay subpath-only.
type _NoCreateRpcClientFromRoot = RootModule["createRpcClient"];
