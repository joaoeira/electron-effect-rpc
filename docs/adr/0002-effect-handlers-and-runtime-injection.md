# ADR 0002: Effect Handlers and Context Injection

Date: 2026-02-08
Status: Accepted (updated for Effect v4)

## Context

Main-process RPC handlers need typed domain failures, defect separation, and
predictable execution semantics. Plain promise handlers can work, but they make
it easier to lose typed error channels and to hide service choices inside global
state.

Effect v4 removed `Runtime<R>` in favor of `Context.Context<R>` plus the
`Effect.run*With` functions.

## Decision

Handlers are defined as `Effect` values and executed by `createRpcEndpoint`
using a service context provided explicitly through `RpcEndpointOptions.context`.
`createRpcEndpoint` does not create or assume an application service context.

## Consequences

This decision preserves explicitness around dependencies and error channels, and
it makes endpoint behavior easier to test because service wiring is visible at
construction time. The downside is a steeper onboarding curve for contributors
unfamiliar with Effect, plus slightly more setup in host applications. The team
accepted that cost to keep transport semantics explicit and strongly typed.
