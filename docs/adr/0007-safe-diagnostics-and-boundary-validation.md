# ADR 0007: Safe Diagnostics and Boundary Validation

Date: 2026-02-08
Status: Accepted

## Context

Observability is essential for diagnosing decode and dispatch issues, but
instrumentation code should never destabilize the transport path itself. At the
same time, unvalidated payloads across process boundaries can create subtle,
hard-to-debug corruption in application state.

## Decision

The library validates payloads at every boundary crossing and routes failures to
typed diagnostics callbacks where available. Callback invocation is wrapped in
`safelyCall`, which swallows callback exceptions so diagnostics cannot crash
core RPC or event behavior.

## Consequences

Transport failures become visible without introducing new fatal paths from
observability code. Boundary validation catches malformed payloads early and
keeps invalid data from silently propagating. The tradeoff is extra runtime work
on decode/encode and the fact that diagnostics callback errors are intentionally
non-fatal and therefore not rethrown.
