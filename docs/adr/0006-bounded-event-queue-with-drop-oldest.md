# ADR 0006: Bounded Event Queue with Drop-Oldest

Date: 2026-02-08
Status: Accepted

## Context

Main-to-renderer events are asynchronous and can outpace renderer readiness.
Without a bounded queue, sustained bursts could cause unbounded memory growth in
the main process. Blocking publishers is also undesirable for many UI update
streams where freshness is more important than complete history.

## Decision

The event publisher uses an in-memory bounded queue controlled by
`maxQueueSize`. When full, it evicts the oldest event before enqueuing the new
one. Queue drain is scheduled asynchronously and continues even when individual
dispatch attempts fail.

## Consequences

Memory use remains bounded under pressure, and recent events are prioritized,
which fits many progress and status-stream use cases. The acknowledged downside
is possible event loss during bursts. This is acceptable for the targeted
workloads and is surfaced through diagnostics so hosts can tune capacity.
