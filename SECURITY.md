# Security policy

## Reporting a problem

Please don't open a public issue for a security problem. Use GitHub's private reporting instead: **Security → Report a vulnerability** on this repository. Include what you ran, what happened, and what you expected. You should hear back within a week.

## What counts

conductor-ai runs other AI agents on your machine, so these matter most:

- A worker escaping its permission rules: editing outside the project in a write role, editing anything in a read role, or running a denied command (`git push`, `sudo`…). See [Providers → Permissions](docs/PROVIDERS.md#permissions-what-each-agent-may-do).
- API keys from `secrets.env` or `.conductor/.env` reaching a worker that shouldn't see them, or appearing in logs or run reports.
- The settings UI (`conductor ui`) being reachable from another machine or another website, or its API working without the per-launch token.
- Model output writing files outside the repository, or into protected files.

Known limits, not vulnerabilities: OpenCode's shell and agents without permission control (Kimi, custom CLIs) are only as contained as their own CLIs allow. These are documented in the providers guide.

## Supported versions

Only the latest release on `main` gets fixes.
