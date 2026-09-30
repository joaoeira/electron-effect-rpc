import { Context, Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import type { RpcClient, RpcClientError } from "effect/rpc";
import { RendererSenderMiddleware } from "../../src/index.ts";

export class AppRpcs extends RpcGroup.make(
  Rpc.make("WhoAmI", { success: Schema.Number }),
  Rpc.make("Hang", { payload: { id: Schema.String } }),
).middleware(RendererSenderMiddleware) {}

export class WorkerRpcs extends RpcGroup.make(
  Rpc.make("Pid", { success: Schema.Number }),
  Rpc.make("Hang", { payload: { id: Schema.String } }),
) {}

export class WorkerClient extends Context.Service<
  WorkerClient,
  RpcClient.FromGroup<typeof WorkerRpcs, RpcClientError.RpcClientError>
>()("test/WorkerClient") {}

/** Reported by the renderer page as a `RESULT <json>` console message. */
export const PageResult = Schema.Struct({
  ok: Schema.Boolean,
  value: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  error: Schema.optionalKey(Schema.String),
});

export type PageResult = typeof PageResult.Type;

/** Posted by the utility process to main so tests can observe its handlers. */
export const WorkerEvent = Schema.Union([
  Schema.Struct({ started: Schema.String }),
  Schema.Struct({ interrupted: Schema.String }),
]);

export type WorkerEvent = typeof WorkerEvent.Type;
