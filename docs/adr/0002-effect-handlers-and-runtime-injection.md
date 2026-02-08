# ADR 0002: Effect Handlers and Runtime Injection

Date: 2026-02-08
Status: Accepted

## Context

Main-process RPC handlers need typed domain failures, defect separation, and
predictable execution semantics. Plain promise handlers can work, but they make
it easier to lose typed error channels and to hide execution environment choices
inside global state.

## Decision

Handlers are defined as `Effect` values and executed by `createRpcEndpoint`
using a runtime provided explicitly through `RpcEndpointOptions.runtime`.
`createRpcEndpoint` does not create or assume a global runtime.

## Consequences

This decision preserves explicitness around dependencies and error channels, and
it makes endpoint behavior easier to test because runtime wiring is visible at
construction time. The downside is a steeper onboarding curve for contributors
unfamiliar with Effect, plus slightly more setup in host applications. The team
accepted that cost to keep transport semantics explicit and strongly typed.
