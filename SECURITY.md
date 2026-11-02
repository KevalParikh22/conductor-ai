# Security

conductor-ai runs other AI agents on your code. Any tool like this has to assume a model can be wrong, or tricked by text it reads (a README, an issue, a web page) into doing something you didn't ask for. This is called prompt injection. This page explains what conductor does about it, what it can't do, and how to set it up for sensitive projects.

**Short answer:** conductor puts several layers between a worker and your machine: per-agent sandboxes, scrubbed keys, git guards and checks on everything a model returns. Every change waits in your working tree for you to review; conductor never commits to your branch or pushes. It cannot make tests or untrusted code safe to run, and anything a worker can read may reach that worker's model provider. The limits are listed below so you can decide what to trust.

## What conductor protects

### 1. Each agent runs under its own rules

Every agent starts with permission flags that conductor sets for that run. They are not saved to your agent's own settings.

| Agent | Write roles | Read roles |
|---|---|---|
| Antigravity (`agy`) | OS sandbox: no network, writes only in the project and temp; secrets files unreadable through its file tools | Same sandbox, no edits |
| Codex CLI | OS sandbox: writes only in the project, `.git` read-only, no network | Read-only sandbox |
| Claude Code (as worker) | File edits only; shell commands that would ask are refused | Edit tools disabled |
| OpenCode | Edits only in the project; **shell not OS-sandboxed** | Edits denied, read-only shell commands |
| Kimi, custom CLIs | Only as contained as the CLI itself | **Not enforced**; conductor warns and checks git afterwards |

For every agent, `git push`, `commit`, `reset`, `checkout`, `rebase`, `stash`, `clean` and `sudo` are denied. Exact flags: [Providers → Permissions](docs/PROVIDERS.md#permissions-what-each-agent-may-do).

### 2. Your keys stay yours

- API keys live in `~/.config/conductor/secrets.env` (mode 600), never in config files or the repo.
- Keys loaded from there are removed from each worker's environment, except the one key that CLI needs. They are also removed from the verify command's environment.
- Files that look like secrets (`.env*`, `auth.json`, `secrets.env`, `.npmrc`, SSH keys, `*.pem`/`*.key`, and anything in `protectedPaths`) are never sent to an API model as context, even if a task asks for them.
- `.env*`, `auth.json`, `app/etc/env.php` and the conductor config folder are unreadable through Antigravity's file tools.

### 3. Git can't be turned against you

- Write roles refuse to run on protected branches (`main`, `master` by default) or a dirty tree, unless you allow it. Parallel tasks run in their own worktrees on `conductor/<id>` branches.
- A failed attempt's changes are stashed, never deleted.
- **Git hooks and `.git/config` are snapshotted before every worker and restored right after it**, before conductor runs git again. A worker that plants a `pre-commit` hook, an `fsmonitor` program, a filter or a diff driver is undone, and the run shows a warning. conductor's own git commands also run with `core.fsmonitor` disabled.
- Hook folders kept in the repo (`.husky/`, `.githooks/`, or your `core.hooksPath`) count as protected files.

### 4. Model output is checked before it touches disk

API models (Kilo, OpenRouter, Gemini…) don't touch your files themselves; they return file blocks, and conductor writes them. Paths outside the repo are rejected, and so are protected files: `AGENTS.md`, `CLAUDE.md`, plans, `.git/`, `.claude/`, `.conductor/`, MCP configs, hook folders, `.env*`, `node_modules/`, and your `protectedPaths`.

After every write task, conductor also:

- Compares the worker's "Files changed" list with git and warns about claims git doesn't back up.
- Warns if a worker modified protected files.
- Warns if a read-only run changed anything.

### 5. The settings page is local only

`conductor ui` listens on `127.0.0.1` only. It checks the `Host` header, which blocks DNS-rebinding attacks from websites, and its API needs a random token that changes each launch. The token is in the URL fragment, so it's never sent to a server or a referrer.

### 6. Small supply chain

conductor has **zero npm dependencies**. It's installed straight from this GitHub repo, so what you run is the code you can read here.

## What conductor cannot protect against

Be clear on these before you use it on sensitive code.

1. **Verify runs code the worker wrote.** Tests are code, and a worker can change both the tests and `package.json` scripts. When conductor runs verify (`npm test` and so on), that code runs as you, outside any sandbox, exactly as if you ran `npm test` yourself. conductor removes its API keys from that environment, but nothing else. For untrusted providers, set `"autoVerify": false` and review the diff before running tests.
2. **Agents can read what your user can read.** Sandboxes block writes and network, not reads. Anything a worker reads, like `~/.ssh` or other projects, can end up in what it sends to its model provider. Keep real secrets out of reach (see the setup below).
3. **Some agents are not fully contained.** OpenCode's shell is not OS-sandboxed, and Kimi and custom CLIs can't be held to read-only. Prefer Antigravity or Codex for sensitive work.
4. **Free API routes may log your prompts.** Kilo free, OpenRouter `:free` and similar routes can keep what you send, including your code, for training or abuse checks. Don't use them on private or client code.
5. **Prompt injection is not solved.** Text in the repo, issues or fetched pages can steer a model. conductor limits what a steered worker can do; it can't stop the model from writing bad code. **Review every diff before you commit**, especially changes to CI workflows (`.github/workflows`), build scripts, dependencies and auth code.
6. **The controller has your access.** Claude Code, or whichever controller you use, runs conductor with its own permissions. conductor doesn't sandbox the controller.

## Recommended setup for sensitive projects

- [ ] Use only sandboxed workers (Antigravity, Codex). Disable the free API providers and OpenCode on the Providers page.
- [ ] Set `"autoVerify": false` and run tests yourself after reviewing the diff.
- [ ] Add your own secrets files to `protectedPaths`, e.g. `"^config/secrets\\.yml$"`.
- [ ] Work on a feature branch or with `--worktree`; never on `main`.
- [ ] Review `git diff` before every commit. Check the warnings in `conductor runs`.
- [ ] For code you don't trust at all, run the whole thing in a container, VM, dev container or cloud sandbox with no access to your real home folder or SSH keys.

## Reporting a problem

Please don't open a public issue for a security problem. Use GitHub's private reporting instead: **Security → Report a vulnerability** on this repository. Include what you ran, what happened and what you expected. You should hear back within a week.

These count as vulnerabilities:

- A worker escaping the rules above: editing outside the project in a write role, editing anything in a read role where that's marked enforced, running a denied command, or a planted hook surviving.
- API keys reaching a worker that shouldn't see them, an API model, or logs and run reports.
- `conductor ui` reachable from another machine or website, or its API working without the token.
- Model output writing outside the repository or into protected files.

The limits in "What conductor cannot protect against" are known and documented, so they are not vulnerabilities.

Only the latest release on `main` gets fixes.
