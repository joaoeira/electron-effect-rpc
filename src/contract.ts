import * as S from "@effect/schema/Schema";

export type SchemaNoContext = S.Schema.AnyNoContext;

export const NoError = S.Never;
export type NoError = typeof NoError;

export type ErrorSchema = SchemaNoContext | NoError;

export function isNoErrorSchema(schema: ErrorSchema): schema is NoError {
  return schema === NoError;
}

export interface RpcMethod<
  Name extends string,
  Req extends SchemaNoContext,
  Res extends SchemaNoContext,
  Err extends ErrorSchema = NoError
> {
  readonly name: Name;
  readonly req: Req;
  readonly res: Res;
  readonly err: Err;
}

export function rpc<
  const Name extends string,
  Req extends SchemaNoContext,
  Res extends SchemaNoContext,
  Err extends ErrorSchema
>(name: Name, req: Req, res: Res, err: Err): RpcMethod<Name, Req, Res, Err>;

export function rpc<
  const Name extends string,
  Req extends SchemaNoContext,
  Res extends SchemaNoContext
>(name: Name, req: Req, res: Res): RpcMethod<Name, Req, Res, NoError>;

export function rpc<const Name extends string>(
  name: Name,
  req: SchemaNoContext,
  res: SchemaNoContext,
  err: ErrorSchema = NoError
): RpcMethod<Name, SchemaNoContext, SchemaNoContext, ErrorSchema> {
  return { name, req, res, err };
}

export interface RpcEvent<
  Payload extends SchemaNoContext,
  Context extends SchemaNoContext | null,
  Name extends string = string
> {
  readonly name: Name;
  readonly payload: Payload;
  readonly context: Context;
}

export function event<
  const Name extends string,
  Payload extends SchemaNoContext,
  Context extends SchemaNoContext
>(name: Name, payload: Payload, context: Context): RpcEvent<Payload, Context, Name>;

export function event<const Name extends string, Payload extends SchemaNoContext>(
  name: Name,
  payload: Payload
): RpcEvent<Payload, null, Name>;

export function event<const Name extends string>(
  name: Name,
  payload: SchemaNoContext,
  context?: SchemaNoContext | null
): RpcEvent<SchemaNoContext, SchemaNoContext | null, Name> {
  return { name, payload, context: context ?? null };
}

export const exitSchemaFor = <
  Name extends string,
  Req extends SchemaNoContext,
  Res extends SchemaNoContext,
  Err extends ErrorSchema
>(
  method: RpcMethod<Name, Req, Res, Err>
) =>
  S.Exit({
    success: method.res,
    failure: method.err,
    defect: S.Defect,
  });

export interface StreamRpcMethod<
  Name extends string,
  Req extends SchemaNoContext,
  Chunk extends SchemaNoContext,
  Err extends ErrorSchema = NoError
> {
  readonly _tag: "StreamRpcMethod";
  readonly name: Name;
  readonly req: Req;
  readonly chunk: Chunk;
  readonly err: Err;
}

export function streamRpc<
  const Name extends string,
  Req extends SchemaNoContext,
  Chunk extends SchemaNoContext,
  Err extends ErrorSchema
>(name: Name, req: Req, chunk: Chunk, err: Err): StreamRpcMethod<Name, Req, Chunk, Err>;

export function streamRpc<
  const Name extends string,
  Req extends SchemaNoContext,
  Chunk extends SchemaNoContext
>(name: Name, req: Req, chunk: Chunk): StreamRpcMethod<Name, Req, Chunk, NoError>;

export function streamRpc<const Name extends string>(
  name: Name,
  req: SchemaNoContext,
  chunk: SchemaNoContext,
  err: ErrorSchema = NoError
): StreamRpcMethod<Name, SchemaNoContext, SchemaNoContext, ErrorSchema> {
  return { _tag: "StreamRpcMethod", name, req, chunk, err };
}

export type AnyStreamMethod = StreamRpcMethod<
  string,
  SchemaNoContext,
  SchemaNoContext,
  ErrorSchema
>;

export type StreamInput<M extends AnyStreamMethod> = S.Schema.Type<M["req"]>;

export type StreamChunk<M extends AnyStreamMethod> = S.Schema.Type<M["chunk"]>;

export type StreamError<M extends AnyStreamMethod> = S.Schema.Type<M["err"]>;

export type ExtractStreamMethod<
  Methods extends readonly AnyStreamMethod[],
  Name extends string
> = Extract<Methods[number], { readonly name: Name }>;

export type AnyMethod = RpcMethod<
  string,
  SchemaNoContext,
  SchemaNoContext,
  ErrorSchema
>;

export type AnyEvent = RpcEvent<SchemaNoContext, SchemaNoContext | null, string>;

export type RpcInput<M extends AnyMethod> = S.Schema.Type<M["req"]>;

export type RpcOutput<M extends AnyMethod> = S.Schema.Type<M["res"]>;

export type RpcError<M extends AnyMethod> = S.Schema.Type<M["err"]>;

export type RpcEventPayload<E extends AnyEvent> = S.Schema.Type<E["payload"]>;

/** Extract a method from a tuple by its name string literal. */
export type ExtractMethod<
  Methods extends readonly AnyMethod[],
  Name extends string
> = Extract<Methods[number], { readonly name: Name }>;

export interface RpcContract<
  Methods extends ReadonlyArray<AnyMethod>,
  Events extends ReadonlyArray<AnyEvent>,
  StreamMethods extends ReadonlyArray<AnyStreamMethod> = readonly []
> {
  readonly methods: Methods;
  readonly events: Events;
  readonly streamMethods: StreamMethods;
}

function collectDuplicates(names: ReadonlyArray<string>): Array<string> {
  const counts = new Map<string, number>();
  const duplicates: string[] = [];

  for (const name of names) {
    const next = (counts.get(name) ?? 0) + 1;
    counts.set(name, next);
    if (next === 2) {
      duplicates.push(name);
    }
  }

  return duplicates;
}

const RESERVED_STREAM_NAMES = new Set(["sf", "stream-cancel"]);

function hasReservedStreamPrefix(name: string): boolean {
  return name.startsWith("stream/");
}

function validateReservedNames(names: ReadonlyArray<string>, kind: string): void {
  for (const name of names) {
    if (RESERVED_STREAM_NAMES.has(name)) {
      throw new Error(
        `${kind} name "${name}" is reserved for internal stream transport.`
      );
    }
    if (hasReservedStreamPrefix(name)) {
      throw new Error(
        `${kind} name "${name}" must not start with "stream/" (reserved for internal stream transport).`
      );
    }
  }
}

export function defineContract<
  const Methods extends ReadonlyArray<AnyMethod>,
  const Events extends ReadonlyArray<AnyEvent>,
  const StreamMethods extends ReadonlyArray<AnyStreamMethod> = readonly []
>(
  input: {
    readonly methods: Methods;
    readonly events: Events;
    readonly streamMethods?: StreamMethods;
  }
): RpcContract<Methods, Events, StreamMethods> {
  const { methods, events } = input;
  const streamMethods = (input.streamMethods ?? []) as unknown as StreamMethods;

  if (!Array.isArray(methods)) {
    throw new Error("RPC contract methods must be an array.");
  }

  if (!Array.isArray(events)) {
    throw new Error("RPC contract events must be an array.");
  }

  if (!Array.isArray(streamMethods)) {
    throw new Error("RPC contract streamMethods must be an array.");
  }

  const methodNames = methods.map((method) => method.name);
  const streamMethodNames = streamMethods.map((m) => m.name);

  const duplicateMethods = collectDuplicates(methodNames);
  if (duplicateMethods.length > 0) {
    throw new Error(
      `Duplicate RPC method name(s): ${duplicateMethods.join(", ")}`
    );
  }

  const duplicateEvents = collectDuplicates(events.map((event) => event.name));
  if (duplicateEvents.length > 0) {
    throw new Error(
      `Duplicate RPC event name(s): ${duplicateEvents.join(", ")}`
    );
  }

  const duplicateStreamMethods = collectDuplicates(streamMethodNames);
  if (duplicateStreamMethods.length > 0) {
    throw new Error(
      `Duplicate stream method name(s): ${duplicateStreamMethods.join(", ")}`
    );
  }

  const crossDuplicates = collectDuplicates([...methodNames, ...streamMethodNames]);
  if (crossDuplicates.length > 0) {
    throw new Error(
      `Name collision between methods and streamMethods: ${crossDuplicates.join(", ")}`
    );
  }

  validateReservedNames(methodNames, "Method");
  validateReservedNames(streamMethodNames, "Stream method");

  return { methods, events, streamMethods };
}
