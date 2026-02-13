# 02 - Typed Errors, Defects, and Diagnostics

One of the biggest benefits of this package is that it separates domain failures
from defects across process boundaries. This guide shows how that split works in
practice and how to instrument it safely.

## Typed domain errors

Define errors as tagged schemas and attach them to the RPC method.

```ts
import * as S from "@effect/schema/Schema";
import { rpc } from "electron-effect-rpc/contract";

export class AccessDeniedError extends S.TaggedError<AccessDeniedError>()(
  "AccessDeniedError",
  {
    message: S.String,
  }
) {}

export const DeleteFile = rpc(
  "DeleteFile",
  S.Struct({ path: S.String }),
  S.Struct({ ok: S.Boolean }),
  AccessDeniedError
);
```

In main process handlers, fail with that tagged error for expected business
conditions.

```ts
import { Effect } from "effect";

DeleteFile: ({ path }) => {
  if (!canDelete(path)) {
    return Effect.fail(new AccessDeniedError({ message: "Not allowed" }));
  }

  return Effect.succeed({ ok: true });
};
```

In renderer, a typed failure is thrown as the same error class.

```ts
import { RpcDefectError } from "electron-effect-rpc/renderer";

try {
  await client.DeleteFile({ path: "/tmp/file.txt" });
} catch (error) {
  if (error instanceof AccessDeniedError) {
    // expected domain path
    console.warn(error.message);
    return;
  }

  if (error instanceof RpcDefectError) {
    // unexpected defect path
    console.error(error.message, error.cause);
    return;
  }

  throw error;
}
```

## Defects are intentionally different

Defects are things like unexpected throws, `Effect.die`, interrupts, malformed
envelopes, and transport-level invoke failures. The renderer receives these as
`RpcDefectError`, which keeps expected business failures and infrastructure
failures from being mixed together.

If a method declares `NoError` and still returns a typed failure, the client
treats that as a defect because contract and behavior are inconsistent.

## Diagnostics hooks

Diagnostics are for observability, not control flow. The transport does not
depend on them and will continue working even if your callback throws.

```ts
const client = createRpcClient(contract, {
  invoke: window.rpc.invoke,
  diagnostics: {
    onDecodeFailure: (context) => {
      logger.warn("decode-failure", context);
    },
    onProtocolError: (context) => {
      logger.error("protocol-error", context);
    },
  },
});
```

On main side:

```ts
const endpoint = createRpcEndpoint(contract, ipcMain, implementations, {
  runtime: Runtime.defaultRuntime,
  diagnostics: {
    onDecodeFailure: (context) => {
      logger.warn("main-decode-failure", context);
    },
    onProtocolError: (context) => {
      logger.error("main-protocol-error", context);
    },
  },
});
```

Treat diagnostics payloads as structured logs. They are most useful when you
attach request IDs and method names in your logger context.

## Envelope mode vs dual mode

`createRpcClient` defaults to `rpcDecodeMode: "envelope"`, which expects the
current response protocol. Use `"dual"` only while migrating older integrations
that still return legacy serialized `Effect.Exit` payloads.

Once migration is complete, switch back to envelope-only mode so protocol
surface stays strict.
