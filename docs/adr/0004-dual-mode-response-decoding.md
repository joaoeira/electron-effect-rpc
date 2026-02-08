# ADR 0004: Dual-Mode Response Decoding

Date: 2026-02-08
Status: Accepted

## Context

The current transport standard is envelope-based, but earlier integrations may
still emit serialized `Effect.Exit` responses. Requiring an immediate
cross-process migration would increase rollout risk and force coordinated
deployments.

## Decision

`createRpcClient` supports `rpcDecodeMode: "dual"` in addition to the default
`"envelope"` mode. In dual mode the client first attempts envelope parsing and
falls back to legacy Exit decoding when parsing fails.

## Consequences

Hosts can migrate incrementally instead of via a flag day. This reduces adoption
friction and production risk while preserving a clear preferred protocol. The
tradeoff is temporary complexity in client decoding logic, which should be
revisited once legacy usage is no longer needed.
