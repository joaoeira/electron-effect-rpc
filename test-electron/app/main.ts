import path from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, ManagedRuntime, Option, Schema } from "effect";
import { RpcClient } from "effect/rpc";
import { app, BrowserWindow, utilityProcess } from "electron";
import type { UtilityProcess } from "electron";
import { RendererSender } from "../../src/index.ts";
import { MainRpcServer, UtilityRpcClient } from "../../src/main.ts";
import { AppRpcs, PageResult, WorkerClient, WorkerEvent, WorkerRpcs } from "./shared.ts";

const dir = path.dirname(fileURLToPath(import.meta.url));

app.dock?.hide();
app.on("window-all-closed", () => {
  // Keep running between tests.
});

// --- Observation -----------------------------------------------------------

const started = new Set<string>();
const interrupted = new Set<string>();

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const waitFor = async (what: string, predicate: () => boolean, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
};

const isWorkerEvent = Schema.is(WorkerEvent);

const forkWorker = (args: ReadonlyArray<string> = []): UtilityProcess => {
  const child = utilityProcess.fork(path.join(dir, "utility.mjs"), [...args]);
  child.on("message", (event) => {
    if (!isWorkerEvent(event)) return;
    if ("started" in event) started.add(event.started);
    else interrupted.add(event.interrupted);
  });
  return child;
};

const decodePageResult = Schema.decodeUnknownOption(Schema.fromJsonString(PageResult));

interface Page {
  readonly win: BrowserWindow;
  readonly result: () => Promise<PageResult>;
}

const openPage = (query: Record<string, string>): Page => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(dir, "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
    },
  });
  const results: Array<PageResult> = [];
  win.webContents.on("console-message", (event) => {
    if (event.message.startsWith("RESULT ")) {
      Option.map(decodePageResult(event.message.slice("RESULT ".length)), (result) =>
        results.push(result),
      );
    }
  });
  void win.loadFile(path.join(dir, "index.html"), { query });
  return {
    win,
    result: async () => {
      await waitFor(`a result from ${JSON.stringify(query)}`, () => results.length > 0);
      return results[0]!;
    },
  };
};

const expectEqual = <A>(actual: A, expected: A, what: string) => {
  if (actual !== expected) {
    throw new Error(`${what}: expected ${String(expected)}, got ${String(actual)}`);
  }
};

const expectValue = (result: PageResult, expected: string | number, what: string) => {
  if (!result.ok) throw new Error(`${what}: page failed: ${result.error}`);
  expectEqual(result.value, expected, what);
};

// --- Application under test ------------------------------------------------

const Handlers = AppRpcs.toLayer({
  WhoAmI: () =>
    Effect.gen(function* () {
      const { webContents } = yield* RendererSender;
      return webContents.id;
    }),
  Hang: ({ id }) =>
    Effect.sync(() => started.add(id)).pipe(
      Effect.andThen(Effect.never),
      Effect.onInterrupt(() => Effect.sync(() => interrupted.add(id))),
    ),
});

const workerClientLayer = (child: UtilityProcess) =>
  Layer.effect(WorkerClient)(RpcClient.make(WorkerRpcs)).pipe(
    Layer.provide(UtilityRpcClient.layerProtocol(child)),
  );

// --- Tests -----------------------------------------------------------------

type Test = readonly [name: string, run: () => Promise<void>];

const makeTests = (
  worker: UtilityProcess,
  runtime: ManagedRuntime.ManagedRuntime<WorkerClient, never>,
) => {
  const tests: Array<Test> = [];
  const test = (name: string, run: () => Promise<void>) => tests.push([name, run]);

  test("a renderer's call reaches main, whose handler sees the calling webContents", async () => {
    const page = openPage({ scenario: "whoami" });
    expectValue(await page.result(), page.win.webContents.id, "WhoAmI");
    page.win.destroy();
  });

  const departures: ReadonlyArray<readonly [string, (win: BrowserWindow) => void]> = [
    ["reloads", (win) => win.webContents.reload()],
    ["navigates away", (win) => void win.loadURL("about:blank")],
    ["crashes", (win) => win.webContents.forcefullyCrashRenderer()],
    ["closes", (win) => win.destroy()],
  ];
  for (const [departure, depart] of departures) {
    test(`a renderer that ${departure} has its in-flight handlers interrupted`, async () => {
      const id = `main:${departure}`;
      const page = openPage({ scenario: "hang", id });
      await waitFor("the handler to start", () => started.has(id));
      depart(page.win);
      await waitFor("the handler to be interrupted", () => interrupted.has(id));
      if (!page.win.isDestroyed()) page.win.destroy();
    });
  }

  test("a renderer that connects before its endpoint is served gets through once it is", async () => {
    const page = openPage({ scenario: "whoami", endpoint: "late" });
    await sleep(500);
    const late = ManagedRuntime.make(
      MainRpcServer.layer(AppRpcs, { endpoint: "late" }).pipe(Layer.provide(Handlers)),
    );
    await late.runPromise(Effect.void);
    expectValue(await page.result(), page.win.webContents.id, "WhoAmI");
    page.win.destroy();
    await late.dispose();
  });

  test("a renderer refused by authorize fails its calls", async () => {
    const page = openPage({ scenario: "expect-failure", endpoint: "admin" });
    expectValue(await page.result(), "RpcClientDefect", "failure reason");
    page.win.destroy();
  });

  test("a renderer refused by the preload allowlist fails its calls", async () => {
    const page = openPage({ scenario: "expect-failure", endpoint: "not-allowed" });
    expectValue(await page.result(), "RpcClientDefect", "failure reason");
    page.win.destroy();
  });

  test("main calls a utility process", async () => {
    const pid = await runtime.runPromise(WorkerClient.use((client) => client.Pid()));
    expectEqual(pid, worker.pid, "Pid");
  });

  test("a renderer reaches a utility process through a forwarded endpoint", async () => {
    const page = openPage({ scenario: "worker-pid", endpoint: "worker" });
    expectValue(await page.result(), worker.pid ?? -1, "Pid");
    page.win.destroy();
  });

  test("a forwarded renderer that reloads has its utility-process handlers interrupted", async () => {
    const id = "worker:reload";
    const page = openPage({ scenario: "worker-hang", endpoint: "worker", id });
    await waitFor("the handler to start", () => started.has(id));
    page.win.webContents.reload();
    await waitFor("the handler to be interrupted", () => interrupted.has(id));
    page.win.destroy();
  });

  test("calls to a utility process that exits fail instead of hanging", async () => {
    const doomed = forkWorker();
    const doomedRuntime = ManagedRuntime.make(workerClientLayer(doomed));
    const call = (effect: (client: WorkerClient["Service"]) => Effect.Effect<unknown, unknown>) =>
      doomedRuntime.runPromise(WorkerClient.use((client) => Effect.flip(effect(client))));

    const inFlight = call((client) => client.Hang({ id: "doomed" }));
    await waitFor("the handler to start", () => started.has("doomed"));
    doomed.kill();

    const inFlightError = await inFlight;
    const laterStartedAt = Date.now();
    const laterError = await call((client) => client.Pid());
    if (Date.now() - laterStartedAt > 1000)
      throw new Error("the later call took over a second to fail");
    expectEqual(
      Schema.is(Schema.Struct({ _tag: Schema.Literal("RpcClientError") }))(inFlightError),
      true,
      "in-flight error",
    );
    expectEqual(
      Schema.is(Schema.Struct({ _tag: Schema.Literal("RpcClientError") }))(laterError),
      true,
      "later error",
    );
    await doomedRuntime.dispose();
  });

  test("calls to a utility process that crashes before serving fail promptly", async () => {
    const crashing = forkWorker(["--crash-on-startup"]);
    const crashingRuntime = ManagedRuntime.make(workerClientLayer(crashing));
    const startedAt = Date.now();
    const error = await crashingRuntime.runPromise(
      WorkerClient.use((client) => Effect.flip(client.Pid())),
    );
    expectEqual(error._tag, "RpcClientError", "error");
    // Well before the 5 second handshake timeout.
    if (Date.now() - startedAt > 2000) throw new Error("the call took over two seconds to fail");
    await crashingRuntime.dispose();
  });

  return tests;
};

// --- Runner ----------------------------------------------------------------

const main = async () => {
  const worker = forkWorker();
  const serverRuntime = ManagedRuntime.make(
    Layer.mergeAll(
      MainRpcServer.layer(AppRpcs),
      MainRpcServer.layer(AppRpcs, { endpoint: "admin", authorize: () => false }),
      MainRpcServer.layerForward({ endpoint: "worker", target: worker }),
    ).pipe(Layer.provide(Handlers)),
  );
  await serverRuntime.runPromise(Effect.void);
  const clientRuntime = ManagedRuntime.make(workerClientLayer(worker));

  let failures = 0;
  for (const [name, run] of makeTests(worker, clientRuntime)) {
    const startedAt = Date.now();
    try {
      await Promise.race([
        run(),
        sleep(20_000).then(() => {
          throw new Error("test timed out");
        }),
      ]);
      console.log(`  ✓ ${name} (${Date.now() - startedAt}ms)`);
    } catch (error) {
      failures++;
      console.log(`  ✗ ${name} (${Date.now() - startedAt}ms)\n      ${String(error)}`);
    }
  }
  console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);

  await clientRuntime.dispose();
  await serverRuntime.dispose();
  worker.kill();
  app.exit(failures === 0 ? 0 : 1);
};

void app.whenReady().then(main);
