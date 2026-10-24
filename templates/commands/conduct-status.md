---
description: Show conductor providers (ready / missing / cooling down), role chains and repo state
disable-model-invocation: true
allowed-tools: Bash(conductor status:*), Bash(conductor doctor:*)
---

Run `conductor status` and show the user a short summary: the role chains with ✓/✗, and any provider that is not ready with its one fix (install command, missing key, or "cooling down"). For install help, run `conductor doctor` and pass on only the relevant lines. Mention that `conductor ui` opens the settings page where roles, providers and the controller can be changed.
