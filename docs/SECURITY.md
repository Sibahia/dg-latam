# Security policy

## Security status and supported releases

Only the latest maintained release line is supported for security fixes.

| Release line | Security support |
| --- | --- |
| `1.27.x` | Supported |
| `1.26.x` and earlier | Unsupported; upgrade before reporting version-specific behavior |

This project includes a legacy Flash client and a multiplayer server that is still under active hardening. Do **not** treat a default checkout or the example container command as a public, hardened service. Until the multiplayer security work and its regression coverage are complete, run it locally or only in a private, trusted test environment.

## Reporting a vulnerability

Please report vulnerabilities privately. Do not open a public issue, post proof-of-concept exploit code, or disclose account/save data in community channels.

1. Open a private Discord ticket in The Minesa Studios community.
2. State that the report is security-sensitive and include a safe way to continue the conversation.
3. Provide the project version or commit, affected component, reproduction steps, expected and observed behavior, impact, and any logs/screenshots with secrets and player data removed.
4. Give maintainers reasonable time to acknowledge and investigate before discussing the issue publicly.

Do not attach account databases, live session tokens, OAuth codes, private keys, or unredacted network captures. If a large encrypted artifact is necessary, first agree on a transfer method in the private ticket. Maintainers will coordinate disclosure after affected releases and operator mitigations are available.

If the report concerns a live community deployment, do not test against other players or accounts. Use an account and server you control, or describe the issue without exploiting it.

## What to expect

Maintainers aim to acknowledge credible reports, confirm scope, and coordinate a fix or mitigation. Response and fix times depend on severity, reproducibility, and volunteer availability; no specific service-level agreement is promised. Please keep the report private until maintainers confirm that disclosure is safe.

## Operator checklist

Before any trusted multiplayer test, at minimum:

- Use a dedicated host and a separate database; do not reuse production or personal credentials.
- Keep `ADMIN_API_SECRET`, Discord tokens, OAuth secrets, MongoDB credentials, and runtime keys outside the repository and out of logs.
- Set a durable, high-entropy `DUNGEONBLITZ_KEY_HEX` for any server whose sessions must survive restarts. Generate it with a cryptographically secure tool and protect it like a password.
- Keep MongoDB private to the server network. Do not publish its port to the internet.
- Expose only the service ports you need: HTTP (`80` in multiplayer mode), game TCP (`8080` by default), and Flash policy TCP (`843`) only when required by the client.
- Keep TCP admission, per-address connection limits, authentication deadlines, idle timeouts, and bounded shutdown enabled. Tune them for measured traffic instead of disabling them during an incident.
- Restrict `SOCKET_POLICY_DOMAINS` to the exact Flash-client host names. The server intentionally refuses wildcard origins and grants only the configured game port.
- Put browser-facing HTTP/OAuth traffic behind TLS at a reverse proxy, set `PUBLIC_BASE_URL` to the public HTTPS URL, and register the exact OAuth redirect URL with Discord.
- Enable `TRUST_PROXY_HEADERS` only for a controlled proxy path and constrain `TRUSTED_PROXY_ADDRESSES` to the immediate proxy hops. Forwarded headers from arbitrary clients are not an identity boundary.
- Never enable `ALLOW_DEV_PASSWORD_RESET` in multiplayer. It is an explicit loopback-only development recovery mechanism and startup rejects unsafe combinations.
- Back up the persisted data before every deployment, verify a restore in a separate environment, and restrict backup access because account and character data may contain personal information.
- Review server logs before sharing them. They can contain usernames, addresses, request data, or operational details.
- Keep Node.js, operating-system packages, and Discord SDK files current from trusted sources; review dependency updates before deployment.

## Secrets and configuration

Copy `src/server/.env.example` to `src/server/.env` only for local configuration, then replace placeholder values with your own. The file is ignored by Git. Never commit:

- `.env` files or shell history containing secrets
- Discord bot/OAuth credentials or Social SDK token caches
- `ADMIN_API_SECRET` or maintenance API secrets
- MongoDB connection strings
- account files, character saves, backups, or diagnostic payloads containing player data

Rotate a secret immediately if it is exposed. Treat a copied server image, public log, or pasted terminal output as a possible disclosure.

## Scope

The policy covers the repository-maintained server, client-patch tooling, container assets, optional Discord integrations, and documentation. Third-party game assets, Flash runtimes, Discord services, operating systems, browsers, and self-hosted reverse proxies have their own security boundaries and update processes.
