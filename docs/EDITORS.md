# tmux and editors

conductor is a plain command (`conductor …`) plus an MCP server (`conductor mcp`). Anything with a terminal, or anything that speaks MCP, can drive it. This page covers two setups that work well day to day: **tmux** for long and parallel runs, and **VS Code** (or Cursor) for reviewing as you go.

## tmux

### The layout

```
┌──────────────────────────────┬──────────────────────────┐
│                              │ conductor runs (live)    │
│  controller                  │ who did what, verify,    │
│  claude / agy / codex        │ evidence warnings        │
│  plans, delegates, reviews   ├──────────────────────────┤
│                              │ shell: git diff,         │
│                              │ worktree list, tests     │
└──────────────────────────────┴──────────────────────────┘
```

From your project folder:

```bash
tmux new-session -d -s conductor -c "$PWD" 'claude' \; split-window -h -c "$PWD" 'while :; do clear; conductor runs --limit 15; sleep 5; done' \; split-window -v -c "$PWD" \; select-pane -t 0 \; attach
```

Replace `claude` with your controller (`agy`, `codex`, `opencode`). The runs loop works on Linux and macOS. If you have `watch`, `watch -n 5 conductor runs` does the same.

### Why it fits

- **Runs survive a closed laptop or dropped SSH.** Detach with `Ctrl-b d`, come back with `tmux attach -t conductor`. Workers keep going, and the run history is in `.conductor/runs/` either way.
- **Parallel tasks don't collide.** `conductor batch --plan docs/plan/x.md --tasks T1,T2,T3` gives each task its own git worktree on branch `conductor/<id>`, spread across providers. Watch them land in the runs pane, check them with `conductor worktree list`, then merge the ones you like.
- **Settings page on a server.** Run `conductor ui --no-open` in a pane. On a remote machine, forward the port first (`ssh -L 4545:127.0.0.1:4545 host`) and open the printed URL locally.

### Handy commands for the shell pane

| Command | What it shows |
|---|---|
| `conductor runs show <run>` | One run in full: attempts, the worker's report, verify output |
| `conductor worktree list` | Parallel task branches and whether they are merged |
| `conductor usage` | Runs, tokens and cost per provider |
| `conductor cooldown` | Providers resting after a rate limit |
| `conductor verify` | The project's verify command (tests, lint) |

## VS Code

Pick whichever way you already work. They all use the same config and run history.

### Claude Code (extension or terminal)

`conductor init` already writes `.mcp.json` and the `/conduct-*` commands, and the Claude Code extension reads them. Open the project, start Claude and type:

```
/conduct-plan add password reset
/conduct-run docs/plan/password-reset.md
```

### Copilot agent mode and other MCP extensions

VS Code reads MCP servers from `.vscode/mcp.json`. Let init write it:

```bash
conductor init --vscode
```

It does this automatically when the project already has a `.vscode/` folder. The entry is merged, so your other servers stay:

```json
{
  "servers": {
    "conductor": { "type": "stdio", "command": "conductor", "args": ["mcp"] }
  }
}
```

The agent then has `conductor_run`, `conductor_batch`, `conductor_status` and `conductor_verify`. For example: *"use conductor_run with role test to add tests for src/auth"*. The same entry works in other MCP clients; **Cursor** reads `.cursor/mcp.json` in the `.mcp.json` shape (`mcpServers`).

### Integrated terminal

Every CLI command works in VS Code's terminal. Split it in two (`Ctrl+Shift+5`) to mirror the tmux layout: the controller on one side, the runs loop on the other.

### Tasks (optional)

Add these to `.vscode/tasks.json` to run conductor from the command palette (**Tasks: Run Task**):

```json
{
  "version": "2.0.0",
  "tasks": [
    { "label": "conductor: runs", "type": "shell", "command": "conductor runs", "problemMatcher": [] },
    { "label": "conductor: verify", "type": "shell", "command": "conductor verify", "problemMatcher": [] },
    { "label": "conductor: status", "type": "shell", "command": "conductor status", "problemMatcher": [] },
    { "label": "conductor: settings", "type": "shell", "command": "conductor ui", "isBackground": true, "problemMatcher": [] }
  ]
}
```

### Review as you go

Keep the **Source Control** panel open. conductor never commits on your main branch, so every change a worker makes appears there for you to review before you commit. Parallel tasks appear as `conductor/<id>` branches.

## Troubleshooting

**"conductor: command not found" from the editor's MCP client.** Editors started from the dock or a menu often don't load your shell's PATH, so they can't see tools installed with nvm or fnm. Put the full path in the MCP entry instead:

```bash
which conductor
```

Then use that path as `"command"` in `.vscode/mcp.json` (or `.mcp.json`).

**The MCP server doesn't appear.** Reload the window (**Developer: Reload Window**), then check the MCP server list in your extension. To check the server itself, run `conductor mcp` by hand: it prints `[conductor] MCP server ready` and then waits for a client on stdin (Ctrl-C to stop).
