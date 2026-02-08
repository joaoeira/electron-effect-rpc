# ADR 0003: Envelope-Based RPC Protocol

Date: 2026-02-08
Status: Accepted

## Context

Transporting raw internal structures across process boundaries can be brittle,
especially when implementations evolve over time. The project needed a wire
format that distinguishes expected domain failures from unexpected defects and
that can be parsed defensively from `unknown`.

## Decision

RPC responses are encoded as explicit envelopes in `src/protocol.ts`, using
three variants: `success`, `failure`, and `defect`. The main endpoint always
returns one of these variants, and the renderer client always attempts to parse
responses through `parseRpcResponseEnvelope` before decoding payloads.

## Consequences

The protocol is now self-describing and easier to evolve safely because each
response category has a stable shape. The renderer can surface typed domain
errors differently from transport defects, which improves caller behavior and
debugging. The cost is extra encode/decode work and stricter adherence to the
envelope contract, but the explicitness is worth it for maintainability.
