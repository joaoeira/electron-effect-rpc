import { Effect, Layer } from "effect";
import { UtilityRpcServer } from "../../src/utility.ts";
import { WorkerRpcs, type WorkerEvent } from "./shared.ts";

const notify = (event: WorkerEvent) => process.parentPort.postMessage(event);

const Handlers = WorkerRpcs.toLayer({
  Pid: () => Effect.sync(() => process.pid),
  Hang: ({ id }) =>
    Effect.sync(() => notify({ started: id })).pipe(
      Effect.andThen(Effect.never),
      Effect.onInterrupt(() => Effect.sync(() => notify({ interrupted: id }))),
    ),
});

if (process.argv.includes("--crash-on-startup")) {
  setTimeout(() => process.exit(1), 300);
} else {
  Effect.runFork(Layer.launch(UtilityRpcServer.layer(WorkerRpcs).pipe(Layer.provide(Handlers))));
}
