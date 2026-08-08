# Audit remediation specification

## Objective

Remediate the security, authority, reliability, release, and documentation defects documented in the end-to-end audit without weakening Flash-client compatibility or local single-player workflows.

## Security invariants

- A password, OAuth callback, account link, transfer, party join, admin operation, or save mutation is accepted only when bound to the authenticated actor and an expiring, one-time server-owned state record.
- The server is authoritative for player identity, character ownership, entity lifecycle, movement, combat legality/damage, rewards, health, progression, party membership, and persistence.
- Client packets are observations or requests, never independent proof of privileged state.
- Public deployment uses explicit configuration, bounded network exposure, persistent secrets, protected data storage, and enforceable CI gates.

## Compatibility constraints

- Local single-player must remain usable without MongoDB, Discord, or a public network.
- Legacy Flash wire formats may be preserved only when they can be constrained by server-owned state; an insecure compatibility fallback is not acceptable for multiplayer.
- Client patch scripts must remain reproducible and verified rather than directly mutating compiled assets.

## Required evidence

Each remediated finding requires a targeted regression that demonstrates the formerly accepted forged, replayed, foreign, concurrent, or invalid action is rejected without mutating canonical state. Shared changes require full-suite, typecheck, and build evidence; client-patch changes require the patch verifier; release/runtime changes require their relevant smoke or configuration tests.

## Non-goals

This effort does not publish secrets, make unverified binary edits, or declare a public multiplayer deployment safe merely because a narrow test passes. Findings that require unavailable vendor tooling or production infrastructure must remain explicitly documented as blocked until verified.
