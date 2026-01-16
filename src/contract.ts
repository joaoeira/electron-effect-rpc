import * as S from "@effect/schema/Schema";

export type SchemaNoContext = S.Schema.AnyNoContext;

export const NoError = S.Never;
export type NoError = typeof NoError;

export type ErrorSchema = SchemaNoContext | S.Schema<never, never, never>;

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
  Events extends ReadonlyArray<AnyEvent>
> {
  readonly methods: Methods;
  readonly events: Events;
}

const collectDuplicates = (names: ReadonlyArray<string>): Array<string> => {
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
};

export const defineContract = <
  const Methods extends ReadonlyArray<AnyMethod>,
  const Events extends ReadonlyArray<AnyEvent>
>(input: {
  readonly methods: Methods;
  readonly events: Events;
}): RpcContract<Methods, Events> => {
  const { methods, events } = input;

  if (!Array.isArray(methods)) {
    throw new Error("RPC contract methods must be an array.");
  }

  if (!Array.isArray(events)) {
    throw new Error("RPC contract events must be an array.");
  }

  const duplicateMethods = collectDuplicates(methods.map((method) => method.name));
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

  return input;
};
