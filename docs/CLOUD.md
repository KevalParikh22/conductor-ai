# Local, cloud and CI

conductor runs anywhere Node 20 runs. The question is which providers are reachable there.

| Environment | Local agents (CLI logins) | Cloud APIs (keys) | Local models |
|---|---|---|---|
| Your laptop / desktop | ✓ | ✓ | ✓ |
| Remote server / VPS / devbox | ✓ if you install and log in there | ✓ | ✓ if it has the hardware |
| Claude Code on the web (cloud sessions) | Only CLIs that accept API keys | ✓ | ✗ |
| GitHub Actions / CI | Only CLIs that accept API keys | ✓ | ✗ |

**Rule of thumb:** on your own machine, use logged-in CLI agents for `build` (they edit and run tests) and cloud APIs for docs, tests and questions. In cloud or CI, use API-key providers; conductor falls through to them automatically because CLIs that aren't installed are skipped.

## Claude Code on the web

Cloud sessions clone your repo, so `.claude/commands/conduct-*`, `.mcp.json` and `.conductor/config.json` come along. What you need to add:

1. **Install conductor in the environment's setup script:**
   ```bash
   npm install -g github:KevalParikh22/conductor-ai
   ```
   Optionally add `npm install -g @openai/codex`. (Antigravity CLI needs an interactive Google sign-in, so in the cloud use API providers instead.)
2. **Provide keys** as environment variables or network secrets in the cloud environment settings: `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, and so on. Codex CLI also runs headless with `CODEX_API_KEY`/`OPENAI_API_KEY`. `kilo-free` needs no key at all.
3. **Allow the hosts.** The default "Trusted" network level reaches `*.googleapis.com` (Gemini). For `openrouter.ai`, `api.openai.com`, `api.moonshot.ai` and similar, choose Custom/Full network access or add a network secret for those hosts.
4. Optionally use a project config tuned for cloud, e.g. `.conductor/config.json`:
   ```json
   { "roles": { "build": ["codex-cli", "gemini-api", "kilo-free"], "docs": ["kilo-free", "openrouter-free", "gemini-api"] } }
   ```

## GitHub Actions

Example: have Claude implement an issue with conductor workers. See [`examples/github-action.yml`](../examples/github-action.yml).

```yaml
- uses: actions/setup-node@v4
  with: { node-version: 22 }
- run: npm install -g github:KevalParikh22/conductor-ai
- uses: anthropics/claude-code-action@v1
  with:
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    prompt: "/conduct-run docs/plan/${{ inputs.plan }}.md"
  env:
    GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
    OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
```

Standalone (no Claude), e.g. a free-model docs refresh on every merge:
```yaml
- run: |
    git switch -c docs/auto-${{ github.run_id }}   # workers never write on main
    conductor run docs "Update README usage section to match src/cli" --files src/cli.js,README.md --chain kilo-free,openrouter-free,gemini-api
```

## Remote server

Install as on a laptop. Since `conductor ui` binds to `127.0.0.1`, reach it through an SSH tunnel and open the printed URL locally:
```bash
ssh -L 4545:127.0.0.1:4545 my-server
```
```bash
conductor ui --no-open
```

## Mixing local and cloud in one chain

Chains can mix kinds freely; the first ready provider wins:
```json
{ "roles": { "test": ["ollama", "opencode", "kilo-free", "openrouter-free"] } }
```
On your laptop Ollama runs first. In CI, Ollama and OpenCode are skipped (not installed) and the cloud APIs take over.
