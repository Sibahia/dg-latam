# Audit remediation plan

## Status

In progress.

## Source

`.ai/audits/audit-08-07-2026-1.md`, audited at `acb2638` / `v1.27.0`.

## Work streams

1. **Authentication and account lifecycle** — AUD-001, AUD-002, AUD-003, AUD-004, AUD-014, AUD-016. Replace unauthenticated/password-bypass flows with bounded, account-bound authentication and one-time session/link state; validate character creation; make recovery local-only and fail closed for multiplayer.
2. **Authoritative multiplayer state** — AUD-005 through AUD-013. Make combat, reward, respawn, movement, entity lifecycle, party admission, progression, and persistence derive from server-owned state; add ownership, nonce, range, lifecycle, and concurrency protections.
3. **Runtime and release hardening** — AUD-015 and AUD-017 through AUD-027. Add admission/rate controls; repair scope reset/startup/shutdown paths; make CI, patch verification, container, socket policy, dependency, and documentation controls enforceable.
4. **Integration verification** — run focused regressions per finding, full server regression suite, typecheck/build, client-patch verifier, dependency audit, and a container smoke test where environment support exists. Update the audit only with evidence after each finding is verified.

## Sequencing

Authentication/session fixes land before Discord/presence integration tests. Authority changes are serialized by shared entity lifecycle and persistence contracts. Operational hardening follows the resulting runtime interfaces. Package versioning and commits happen only after integrated verification.

## Completion criteria

- Every AUD-001 through AUD-027 finding has a current-state disposition: fixed with direct test evidence, deliberately deferred with an approved external blocker, or superseded by a stronger control.
- No critical/high finding remains exploitable in the supported multiplayer configuration.
- CI executes the required test and verification gates.
- Public hosting documentation matches the implemented security posture.
