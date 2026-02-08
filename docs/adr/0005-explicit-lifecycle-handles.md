# ADR 0005: Explicit Lifecycle Handles

Date: 2026-02-08
Status: Accepted

## Context

Electron applications often have nuanced startup and teardown phases, and tests
need predictable registration and cleanup behavior. Implicit registration at
construction time tends to hide ordering issues and can leave stale handlers or
subscriptions behind.

## Decision

`createRpcEndpoint` and `createEventPublisher` return lifecycle objects with
`start`, `stop`, `dispose`, and `isRunning`. `stop` and `dispose` are idempotent
operations, while `dispose` is terminal and prevents restart.

## Consequences

Lifecycle transitions are explicit and testable, which improves reliability in
both runtime code and test harnesses. The tradeoff is that callers must manage
lifecycle deliberately rather than relying on implicit behavior. This is treated
as an acceptable burden because hidden lifecycle work causes harder failures.
