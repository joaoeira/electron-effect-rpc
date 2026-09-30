import { Cause, Effect } from "effect";
import { RpcClient } from "effect/rpc";
import { RendererRpcClient } from "../../src/renderer.ts";
import { AppRpcs, WorkerRpcs, type PageResult } from "./shared.ts";

const params = new URLSearchParams(location.search);
const scenario = params.get("scenario");
const endpoint = params.get("endpoint") ?? "default";
const id = params.get("id") ?? "";

const report = (result: PageResult) => console.log(`RESULT ${JSON.stringify(result)}`);

const program = Effect.gen(function* () {
  switch (scenario) {
    case "whoami": {
      const client = yield* RpcClient.make(AppRpcs);
      report({ ok: true, value: yield* client.WhoAmI() });
      return;
    }
    case "hang": {
      const client = yield* RpcClient.make(AppRpcs);
      yield* client.Hang({ id });
      return;
    }
    case "worker-pid": {
      const client = yield* RpcClient.make(WorkerRpcs);
      report({ ok: true, value: yield* client.Pid() });
      return;
    }
    case "worker-hang": {
      const client = yield* RpcClient.make(WorkerRpcs);
      yield* client.Hang({ id });
      return;
    }
    case "expect-failure": {
      const client = yield* RpcClient.make(AppRpcs);
      const error = yield* Effect.flip(client.WhoAmI());
      report({ ok: true, value: error.reason._tag });
      return;
    }
    default:
      report({ ok: false, error: `unknown scenario ${String(scenario)}` });
  }
}).pipe(
  Effect.provide(RendererRpcClient.layerProtocol({ endpoint })),
  Effect.scoped,
  Effect.catchCause((cause) =>
    Effect.sync(() => report({ ok: false, error: Cause.pretty(cause) })),
  ),
);

Effect.runFork(program);
