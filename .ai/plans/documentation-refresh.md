# Documentation refresh plan

## Status

Completed.

## Scope

Refresh the repository-maintained Markdown documentation for players, operators, security reporters, and optional native-bridge developers. Internal agent guidance and existing audit records are out of scope except where they define documentation placement.

## Steps

1. Inventory the Markdown files and validate their claims against scripts, configuration, and container files.
2. Rewrite the player README with clear local setup, saving, playtest-account, troubleshooting, and documentation links.
3. Replace the obsolete hosting guide with accurate container, environment, networking, persistence, and operational guidance.
4. Refresh the security policy and native-bridge guide with safe reporting, limitations, setup, and verification details.
5. Review all changed Markdown for consistency, link accuracy, and Markdown formatting.

## Verification

- `git diff --check`
- Manual link/path and command validation against repository files

## Outcome

Rewrote the README, hosting guide, security policy, and native-bridge guide; refreshed the pull-request template; and validated local Markdown links and diff whitespace. The hosting documentation now states that the current multiplayer stack is for trusted testing rather than untrusted public deployment.
