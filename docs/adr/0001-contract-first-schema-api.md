# ADR 0001: Contract-First Schema API

Date: 2026-02-08
Status: Accepted

## Context

Electron IPC often drifts when channels, payload shapes, and call sites are
defined independently in main and renderer code. That drift can remain hidden
until runtime, where errors are harder to diagnose and usually discovered late.
The project needed one place to define method names, payload schemas, and error
shapes so both compile-time and runtime behavior stay aligned.

## Decision

The library uses a contract-first model centered on `rpc`, `event`, and
`defineContract` from `src/contract.ts`. Methods and events are declared once
with `@effect/schema` definitions and consumed from both processes. Runtime
guards in `defineContract` reject duplicate method and event names to preserve a
stable mapping from name to behavior.

## Consequences

The primary benefit is that type inference and runtime validation are generated
from the same source, which sharply reduces mismatch risk across process
boundaries. The cost is that teams must model contracts up front instead of
shipping ad hoc IPC calls. That tradeoff is intentional because contract drift
is more expensive than initial modeling effort.
