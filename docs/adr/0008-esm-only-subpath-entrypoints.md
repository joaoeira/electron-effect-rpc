# ADR 0008: ESM-Only Package with Subpath Entrypoints

Date: 2026-02-08
Status: Accepted

## Context

The package targets modern Electron and TypeScript tooling where ESM is the
expected module format. A single barrel entry point would be convenient, but it
would also blur process-specific boundaries and increase the chance of importing
main-only code into renderer contexts.

## Decision

The package is ESM-only and exposes focused subpath entry points such as
`/main`, `/renderer`, `/preload`, `/contract`, `/types`, and `/testing`.

## Consequences

Consumers get clearer import intent and reduced accidental cross-context usage.
The downside is reduced compatibility for CommonJS-only environments, which must
use adaptation strategies outside this package. Given the target ecosystem, the
clarity and correctness benefits outweighed broad legacy support.
