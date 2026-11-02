# Contributing

Thanks for helping! conductor has **no runtime dependencies**. Please keep it that way.

```bash
git clone https://github.com/KevalParikh22/conductor-ai && cd conductor-ai
npm test                 # node:test, no network: CLIs and APIs are mocked
node bin/conductor.js ui # try the settings page against the current folder
```

Good first contributions:
- **A CLI changed its flags?** Update its preset in `src/presets.js` and the table in `docs/PROVIDERS.md`.
- **New provider:** add it to `DEFAULT_PROVIDERS` (disabled by default unless it's free and common) and document it.
- **New controller:** see "Extending" in `docs/ARCHITECTURE.md`.

Guidelines: small PRs; add a test in `test/` for behaviour changes; never log or persist API keys; keep the UI working without external assets.
