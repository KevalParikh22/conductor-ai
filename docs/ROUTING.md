# Routing: decide which worker takes which task

Each role (build, fix, test, docs, review, ask) has a chain: providers it tries in order. Routing lets you put a different provider at the front for certain kinds of task. For example:
- logins and payments go to the agent you trust most;
- docs go to a free or local model;
- React work goes to the agent you find best at UI.

You write this down once instead of typing `--provider` on every command.

## How it works

1. **A rule matches a task** by its **files** (globs), its **text** (a regex) or its **role**. Every condition the rule names must hold.
2. **The rule's providers run first.** The role's chain stays behind them, so if the routed provider is rate-limited, not installed or fails, the task still runs on the next one.
3. **Rules are checked top to bottom, and the first match wins.** Keep risky rules (security, database) at the top, above broad ones like "all `.php` files".
4. **A task no rule matches** goes to the smart selector as before: free models for small tasks, agents for big ones.

The full order, highest first:

| # | What decides | Example |
|---|---|---|
| 1 | `--chain` on the command | `conductor build "…" --chain codex-cli,opencode` |
| 2 | `--provider` on the command | `conductor fix "…" --provider claude-cli` |
| 3 | The plan task's `provider:` line | `- **provider:** grok-cli` |
| 4 | The first matching rule in `routes` | `{ "files": "*.sql", "provider": "codex-cli" }` |
| 5 | The smart selector | reorders the role's chain by task size |

Each run's summary says which step decided (`route: route 1: files *.sql → codex-cli`), and so does the Runs page in `conductor ui`.

## Quick start

Add the starter set: security, database, CI/infrastructure, small edits, docs files and the docs role. Run this inside your project:

```bash
conductor route --add starter
```

The providers are filled in from the ones you have enabled. A "strong agent" rule gets your best agent CLIs (Claude Code, Codex, Antigravity…), and a "free or local" rule gets Ollama or LM Studio if they're on, then kilo-free and openrouter-free. Then try a task without running anything:

```bash
conductor route "fix the login redirect" --files src/Login.tsx
```

In the UI it's the same. Open `conductor ui` → **Roles** → **Routing**:
- **Add starter set** adds the starter rules.
- **Add** adds one rule.
- **Customize** copies a rule into the form so you can change it first.
- **Preview** shows where a task would go.

Then **Save**.

## The rule library

★ marks the starter set. Add any rule by its id: `conductor route --add tests,frontend`.

| Id | Rule | Matches | Goes to | Why |
|---|---|---|---|---|
| ★ `security` | Security-sensitive code | text `\b(auth\|login\|password\|token\|secret\|session\|payment\|checkout\|permission\|encrypt\|csrf\|oauth)` | your strongest agent | Logins, payments and secrets go to the agent you trust most, never to a free model. |
| ★ `database` | Database and migrations | files `*.sql`, `**/migrations/**`, `**/migration/**`, `**/db/**`, `**/Setup/**` | your strongest agent | Schema changes are hard to undo, so a strong agent that can run and check them does it. |
| ★ `infra` | CI, Docker and infrastructure | files `Dockerfile`, `docker-compose*.yml`, `.github/**`, `*.tf`, `**/k8s/**`, `nginx*.conf`, `Makefile` | your strongest agent | A wrong line here breaks builds or deploys for everyone. |
| ★ `small-edits` | Small edits | text `\b(typo\|spelling\|rename\|comment\|docstring\|lint\|format(ting)?\|whitespace)\b` | a free or local model | Tiny changes cost nothing on a free or local model. |
| `tests` | Test files | files `*.test.*`, `*.spec.*`, `*Test.php`, `**/tests/**`, `**/test/**`, `**/__tests__/**` | an agent that runs tests | Writing tests needs an agent that can run them and read the failures. |
| `frontend` | Frontend and styling | files `*.tsx`, `*.jsx`, `*.vue`, `*.svelte`, `*.css`, `*.scss`, `*.less`, `*.html`, `*.phtml` | an agent good at UI | UI work goes to the agent you find best at layout and components. |
| `backend` | Backend code | files `*.php`, `*.py`, `*.go`, `*.rb`, `*.java`, `*.cs`, `*.rs` | your strongest agent | Server logic goes to a strong coding agent. |
| ★ `docs-files` | Docs and Markdown | files `*.md`, `*.mdx`, `*.rst`, `docs/**` | a free or local model | Writing docs does not need an expensive model. |
| `translations` | Translations | files `**/locales/**`, `**/i18n/**`, `**/lang/**`, `*.po` | a free or local model | Translation files are repetitive text: a free model handles them. |
| ★ `docs-role` | Docs role | role `docs` | a local model, else a free one | Every docs task tries a free or local model first. |
| `ask-role` | Questions | role `ask` | a local model, else a free one | Questions about your code stay on your machine when a local model is on. |
| `review-role` | Reviews | role `review` | your strongest agent | A careful reviewer catches what the writer missed. |

When you add several rules, conductor keeps them in this table's order (risky first), whatever order you add them in. Your own rules stay where you put them.

## Managing rules from the terminal

```bash
conductor route --templates
```
Lists the library with the providers each rule would get on this machine, and marks the ones already added.

```bash
conductor route --rules
```
Shows your rules, numbered, in the order they're checked.

```bash
conductor route --rm 3
```
Removes rule 3.

Rules are saved to the project (`.conductor/config.json`), because they depend on the project's layout. Add `--global` to save them for every project instead (`~/.conductor/config.json`).

## Writing your own rules

A rule is a JSON object in `routes`:

```json
{
  "routes": [
    { "files": ["src/checkout/**", "app/code/*/Payment/**"], "provider": ["claude-cli", "codex-cli"] },
    { "text": "migration|schema|alter table", "provider": "codex-cli" },
    { "role": "docs", "files": "*.md", "provider": "ollama" },
    { "role": "build", "files": "*.tsx", "text": "chart|graph", "provider": "antigravity-cli" }
  ]
}
```

| Field | Matches when | Notes |
|---|---|---|
| `files` | at least one of the task's files matches one of the globs | A string or a list. `**` spans folders, `*` stays inside one, `?` is one character. A glob with no `/` (like `*.sql`) matches that file name in any folder. The task's files come from `--files` or the plan task's `files:` line. |
| `text` | the regex matches the task description | Case is ignored. In JSON, write `\b` as `\\b`. |
| `role` | the task's role is this one | A string or a list: `"build"`, `["build", "fix"]`. |
| `provider` | (required) who goes first | One name or a list. Each must be a provider in your config. |

A rule needs at least one of `files`, `text` or `role`. `conductor doctor` and the UI flag unknown providers and broken regexes. Rules added from the library also carry `"from": "<id>"`, which conductor uses to avoid adding one twice. You can delete it.

A ready-made file with every library rule (using the default providers) is in [templates/routes.example.json](../templates/routes.example.json). Copy the rules you want into your project's `.conductor/config.json`.

## Pinning one task in a plan

For a one-off decision, put a `provider:` line under the plan task. It beats every rule:

```markdown
### T3: Booking date picker
- **role:** build
- **files:** src/frontend/Booking.tsx
- **provider:** grok-cli
```

A list works too: `- **provider:** grok-cli, antigravity-cli`. Check it with:
```bash
conductor route --plan docs/plan/booking.md --task T3
```

`conductor batch` keeps routed tasks on their provider. Tasks with no route are still spread across providers so they run in parallel.

## Tips

- **Start small:** the starter set and two or three rules of your own cover most projects.
- **Preview before you trust a rule.** Try one task that should match and one that shouldn't.
- **List files in your tasks** (`--files` or the plan's `files:` line). `files` rules can't match a task that names no files.
- **Keep sensitive work away from free models.** Free tiers may log prompts, so put the `security` rule at the top.
- **Turn on a local model** (`conductor local --enable`). The `docs-role` and `ask-role` rules then use it, and those tasks stay on your machine.
