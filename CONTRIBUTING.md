# Contributing

Thanks for helping! conductor-ai has **no runtime dependencies**. Please keep it that way.

```bash
git clone https://github.com/KevalParikh22/conductor-ai && cd conductor-ai
npm test                 # node:test, no network: CLIs and APIs are mocked
node bin/conductor-ai.js ui # try the settings page against the current folder
```

Good first contributions:
- **A CLI changed its flags?** Update its preset in `src/presets.js` and the table in `docs/PROVIDERS.md`.
- **New provider:** add it to `DEFAULT_PROVIDERS` (disabled by default unless it's free and common) and document it.
- **New controller:** see "Extending" in `docs/ARCHITECTURE.md`.

Guidelines: small PRs; add a test in `test/` for behaviour changes; never log or persist API keys; keep the UI working without external assets.

## Licensing of contributions

conductor-ai's core is MIT licensed, and it stays MIT. Paid add-ons may come later under a separate licence (the Functional Source License), in their own folder or package; they build on the core and never change its licence.

By sending a contribution (a pull request, patch or suggested change), you agree that:
- you wrote it, or have the right to submit it;
- it is licensed under the MIT License, like the rest of the core;
- the maintainer may also use it, as a whole or in part, in conductor-ai add-ons under their own licence.

Add `Signed-off-by: Your Name <email>` to your commits (`git commit -s`) to confirm this.
