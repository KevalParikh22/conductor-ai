// Built-in knowledge: how to drive each CLI agent, default providers, roles and controllers.
// Everything here can be overridden in config (global or per project).

// Commands no worker may run: conductor commits and merges, the controller pushes.
export const DENIED_COMMANDS = ['git push', 'git commit', 'git reset', 'git checkout', 'git switch', 'git rebase', 'git stash', 'git clean', 'sudo'];
// Shell commands read-only workers may still run (prefixes).
export const READ_ONLY_COMMANDS = ['git diff', 'git log', 'git show', 'git status', 'git blame', 'git grep', 'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'pwd'];
// Files no worker may read (agy rules; deny read also denies write). {cwd} = the folder the worker runs in.
const SECRET_FILE_RULES = ['read_file({cwd}/.env)', 'read_file({cwd}/.conductor/.env)', 'read_file({cwd}/auth.json)',
  'read_file({cwd}/app/etc/env.php)', 'read_file({conductorHome})'];

/**
 * CLI agent presets. Arg tokens:
 *   {prompt}           the full prompt text (avoid for very long prompts; prefer stdin or {promptFile})
 *   {promptFile}       path to a file holding the prompt
 *   {outFile}          path the CLI may write its final answer to (read back if non-empty)
 *   {modelArgs}        expands to `modelArgs` with {model} filled in, or to nothing when no model is set
 *   {sessionSettings}  `sessionSettings[mode]` as one JSON string
 * `stdin: true` pipes the prompt to the process. `modeEnv[mode]` adds environment variables (objects are
 * sent as JSON). In sessionSettings and modeEnv, {cwd} is the worker's folder and {conductorHome} is
 * conductor's own folder (config, secrets). `passEnv` lists the keys from conductor's secret files this CLI
 * may see; every other secret conductor loaded is removed from its environment.
 * `permissions` describes what each mode allows (shown by `conductor providers` and the UI).
 */
export const CLI_PRESETS = {
  antigravity: {
    label: 'Antigravity CLI (agy)',
    bin: 'agy',
    // agy takes the prompt only through -p (no plain-text stdin). Very long prompts are swapped for a
    // pointer to {promptFile} by runCli. {sessionSettings} is passed with --settings: it applies to this
    // run only and is never saved, so the user's own ~/.gemini/antigravity-cli/settings.json is untouched.
    // Not --mode plan for reads: plan mode saves its answer as a plan artifact and prints only a link.
    write: ['{modelArgs}', '--mode', 'accept-edits', '--sandbox', '--settings', '{sessionSettings}', '--print-timeout', '0', '-p', '{prompt}'],
    read: ['{modelArgs}', '--sandbox', '--settings', '{sessionSettings}', '--print-timeout', '0', '-p', '{prompt}'],
    sessionSettings: {
      // shell commands run in agy's terminal sandbox without asking: no network, home folder read-only
      write: {
        toolPermission: 'proceed-in-sandbox',
        allowNonWorkspaceAccess: false,
        permissions: { deny: ['write_file({cwd}/.git)', ...SECRET_FILE_RULES, ...DENIED_COMMANDS.map((c) => `command(${c})`)] },
      },
      read: {
        toolPermission: 'proceed-in-sandbox',
        allowNonWorkspaceAccess: false,
        permissions: { deny: ['write_file({cwd})', ...SECRET_FILE_RULES] },
      },
    },
    modelArgs: ['--model', '{model}'],
    permissions: {
      write: 'edits inside the project only; shell commands sandboxed (no network, nothing outside the project and temp folders); git push/commit/reset and sudo denied',
      read: 'no file writes in the project; read-only shell commands in the sandbox',
      readOnlyEnforced: true,
    },
    install: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    login: 'agy   (sign in with Google once; headless runs reuse the cached login)',
    docs: 'https://antigravity.google/docs/permissions?tab=cli',
  },
  codex: {
    label: 'Codex CLI',
    bin: 'codex',
    stdin: true, // "-" = read prompt from stdin
    // codex exec never prompts; its OS sandbox decides. workspace-write keeps .git read-only and has no network.
    write: ['exec', '--skip-git-repo-check', '--sandbox', 'workspace-write', '-c', 'approval_policy="never"',
      '-c', 'sandbox_workspace_write.network_access=false', '{modelArgs}', '-o', '{outFile}', '-'],
    read: ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-c', 'approval_policy="never"', '{modelArgs}', '-o', '{outFile}', '-'],
    modelArgs: ['-m', '{model}'],
    passEnv: ['OPENAI_API_KEY'],
    permissions: {
      write: 'OS sandbox: writes only inside the project (and temp), .git read-only, no network, never asks',
      read: 'OS sandbox: read-only, no network',
      readOnlyEnforced: true,
    },
    install: 'npm install -g @openai/codex',
    login: 'codex login   (or: printenv OPENAI_API_KEY | codex login --with-api-key)',
    docs: 'https://developers.openai.com/codex/security',
  },
  opencode: {
    label: 'OpenCode',
    bin: 'opencode',
    // OPENCODE_CONFIG_CONTENT layers these permission rules over the user's config for this run only.
    // --standalone is required: otherwise OpenCode 2 hands the run to its background service, which uses
    // its own config and ignores this environment. --auto approves whatever is not explicitly denied;
    // without it, anything that would ask is rejected.
    write: ['run', '--standalone', '--auto', '{modelArgs}', '-f', '{promptFile}', 'Follow the instructions in the attached file exactly.'],
    read: ['run', '--standalone', '{modelArgs}', '-f', '{promptFile}', 'Follow the instructions in the attached file exactly. Do not modify any files.'],
    modeEnv: {
      write: { OPENCODE_CONFIG_CONTENT: { permission: {
        external_directory: 'deny',
        bash: { '*': 'allow', ...Object.fromEntries(DENIED_COMMANDS.map((c) => [`${c}*`, 'deny'])) },
      } } },
      read: { OPENCODE_CONFIG_CONTENT: { permission: {
        edit: 'deny', external_directory: 'deny', webfetch: 'deny',
        bash: { '*': 'deny', ...Object.fromEntries(READ_ONLY_COMMANDS.map((c) => [`${c}*`, 'allow'])) },
      } } },
    },
    modelArgs: ['-m', '{model}'],
    passEnv: ['OPENCODE_API_KEY', 'OPENROUTER_API_KEY'],
    permissions: {
      write: 'edits inside the project only; git push/commit/reset and sudo denied; shell commands are not sandboxed (OpenCode only blocks outside paths it can detect)',
      read: 'edits denied; only read-only shell commands (git diff/log/show/status, ls, cat, grep, rg...)',
      readOnlyEnforced: true,
    },
    install: 'curl -fsSL https://opencode.ai/install | bash   (or: npm install -g opencode-ai)',
    login: 'opencode auth login',
    docs: 'https://opencode.ai/docs/permissions/',
  },
  kimi: {
    label: 'Kimi Code CLI',
    bin: 'kimi',
    write: ['{modelArgs}', '-p', '{prompt}'],
    read: ['{modelArgs}', '-p', '{prompt}'],
    modelArgs: ['-m', '{model}'],
    passEnv: ['MOONSHOT_API_KEY'],
    permissions: {
      write: 'no permission control in print mode: it can run any command. Only use it in a container or a worktree you can throw away',
      read: 'NOT enforced: read-only is only asked for in the prompt',
      readOnlyEnforced: false,
    },
    install: 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash   (or: uv tool install --python 3.13 kimi-cli)',
    login: 'kimi, then /login',
    docs: 'https://www.kimi.com/code/docs/en/kimi-code-cli/getting-started.html',
  },
  claude: {
    label: 'Claude Code (as a worker)',
    bin: 'claude',
    stdin: true,
    // In -p mode anything that would ask is refused. Not plan mode for reads: it ends in a plan, not an answer.
    write: ['-p', '{modelArgs}', '--permission-mode', 'acceptEdits', '--disallowedTools', ...DENIED_COMMANDS.map((c) => `Bash(${c}:*)`)],
    read: ['-p', '{modelArgs}', '--permission-mode', 'default', '--disallowedTools', 'Edit', 'Write', 'NotebookEdit'],
    modelArgs: ['--model', '{model}'],
    passEnv: ['ANTHROPIC_API_KEY'],
    permissions: {
      write: 'file edits auto-approved; shell commands that would ask are refused; git push/commit/reset and sudo denied',
      read: 'edit tools disabled; shell commands that would ask are refused',
      readOnlyEnforced: true,
    },
    install: 'npm install -g @anthropic-ai/claude-code',
    login: 'claude   (then /login)',
    docs: 'https://code.claude.com/docs/en/permissions',
  },
};

/** Default provider registry. type: cli | openai (any OpenAI-compatible API) | anthropic */
export const DEFAULT_PROVIDERS = {
  'antigravity-cli': { type: 'cli', preset: 'antigravity', enabled: true, model: '', notes: 'Daily driver. Google\'s agent CLI (agy), uses your Google AI Pro login. Replaced Gemini CLI, which Google retired for personal accounts on 18 June 2026.' },
  'codex-cli': { type: 'cli', preset: 'codex', enabled: true, model: '', notes: 'Daily driver. Uses your ChatGPT login or an OpenAI API key.' },
  'opencode': { type: 'cli', preset: 'opencode', enabled: true, model: 'opencode/big-pickle', notes: 'Free models through OpenCode. Good for tests and docs.' },
  'kimi-cli': { type: 'cli', preset: 'kimi', enabled: false, model: '' },
  'claude-cli': { type: 'cli', preset: 'claude', enabled: false, model: '', notes: 'Claude as a worker (spends Claude quota).' },

  'gemini-api': { type: 'openai', enabled: true, baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKeyEnv: 'GEMINI_API_KEY', model: 'gemini-3.8-flash', notes: 'Free tier from Google AI Studio.' },
  'openrouter-free': { type: 'openai', enabled: true, baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY', model: 'openrouter/free', free: true, notes: 'Any ":free" model. 20 req/min, 50/day (1000/day after $10 credit).' },
  'openai-api': { type: 'openai', enabled: false, baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY', model: 'gpt-6-luna' },
  'kimi-api': { type: 'openai', enabled: false, baseUrl: 'https://api.moonshot.ai/v1', apiKeyEnv: 'MOONSHOT_API_KEY', model: 'kimi-latest' },
  'deepseek-api': { type: 'openai', enabled: false, baseUrl: 'https://api.deepseek.com/v1', apiKeyEnv: 'DEEPSEEK_API_KEY', model: 'deepseek-chat' },
  'kilo-free': { type: 'openai', enabled: true, baseUrl: 'https://api.kilo.ai/api/gateway', apiKeyEnv: 'KILO_API_KEY', apiKeyOptional: true, model: 'kilo-auto/free', free: true, notes: 'Kilo Gateway free models. Works without a key (about 200 req/hour per IP). Free routes may log prompts.' },
  'opencode-zen': { type: 'openai', enabled: true, baseUrl: 'https://opencode.ai/zen/v1', apiKeyEnv: 'OPENCODE_API_KEY', model: 'deepseek-v4.1-flash-free', free: true, notes: 'OpenCode Zen API: the same "-free" models as the OpenCode CLI, without the CLI. Key from opencode.ai/zen.' },
  'groq-api': { type: 'openai', enabled: false, baseUrl: 'https://api.groq.com/openai/v1', apiKeyEnv: 'GROQ_API_KEY', model: '', notes: 'Free tier, very fast. About 30 req/min, 1000/day. Pick a model with: conductor models groq-api' },
  'cerebras-api': { type: 'openai', enabled: false, baseUrl: 'https://api.cerebras.ai/v1', apiKeyEnv: 'CEREBRAS_API_KEY', model: '', notes: 'Free tier, very fast. Pick a model with: conductor models cerebras-api' },
  'mistral-api': { type: 'openai', enabled: false, baseUrl: 'https://api.mistral.ai/v1', apiKeyEnv: 'MISTRAL_API_KEY', model: 'codestral-latest', notes: 'Free "Experiment" plan includes Codestral. Prompts may be used for training.' },
  'nvidia-nim': { type: 'openai', enabled: false, baseUrl: 'https://integrate.api.nvidia.com/v1', apiKeyEnv: 'NVIDIA_API_KEY', model: '', notes: 'Free developer access, about 40 req/min. Pick a model with: conductor models nvidia-nim' },
  'claude-api': { type: 'anthropic', enabled: false, baseUrl: 'https://api.anthropic.com', apiKeyEnv: 'ANTHROPIC_API_KEY', model: 'claude-sonnet-5-5' },
  'ollama': { type: 'openai', enabled: false, baseUrl: 'http://localhost:11434/v1', apiKeyEnv: '', model: 'qwen3-coder', free: true, notes: 'Local model, free, private.' },
  'lmstudio': { type: 'openai', enabled: false, baseUrl: 'http://localhost:1234/v1', apiKeyEnv: '', model: '', free: true },
};

/** Roles. mode "write" may change files; "read" must not. */
export const ROLES = {
  build:  { mode: 'write', prompt: 'build',  label: 'Build',  description: 'Implement a planned task (main coding work).' },
  fix:    { mode: 'write', prompt: 'build',  label: 'Fix',    description: 'Small, focused bug fixes and review follow-ups.' },
  test:   { mode: 'write', prompt: 'test',   label: 'Tests',  description: 'Write or extend tests. Good fit for free models.' },
  docs:   { mode: 'write', prompt: 'docs',   label: 'Docs',   description: 'README, docs, comments, changelogs. Good fit for free models.' },
  review: { mode: 'read',  prompt: 'review', label: 'Review', description: 'Second-opinion code review of a diff.' },
  ask:    { mode: 'read',  prompt: 'ask',    label: 'Ask',    description: 'Read-only questions about the codebase or research.' },
};

export const DEFAULT_ROLES = {
  build: ['antigravity-cli', 'codex-cli', 'opencode'],
  fix: ['codex-cli', 'antigravity-cli', 'opencode'],
  test: ['opencode', 'kilo-free', 'openrouter-free', 'antigravity-cli'],
  docs: ['openrouter-free', 'kilo-free', 'opencode-zen', 'opencode', 'gemini-api', 'antigravity-cli'],
  review: ['codex-cli', 'antigravity-cli', 'gemini-api', 'kilo-free'],
  ask: ['antigravity-cli', 'gemini-api', 'kilo-free', 'openrouter-free'],
};

/** Who plans, reviews and commits. `conductor init` writes the matching instruction files. */
export const CONTROLLERS = {
  'claude-code': { label: 'Claude Code', file: 'CLAUDE.md' },
  'antigravity': { label: 'Antigravity CLI', file: 'GEMINI.md' },
  'codex-cli': { label: 'Codex CLI', file: 'AGENTS.md' },
  'opencode': { label: 'OpenCode', file: 'AGENTS.md' },
};

export const DEFAULT_SETTINGS = {
  timeoutSec: 1200,
  protectedBranches: ['main', 'master'],
  protectedPaths: [], // extra regexes for files workers must never write, e.g. "^app/etc/env\\.php$"
  requireCleanTree: true,
  verify: '',
  autoVerify: true,
  dailyBudgetUSD: 0, // 0 = no cap; counts API providers that have a `price` set
  cooldownMinutes: 30,
  maxDiffBytes: 100000,
  maxContextBytes: 60000,
  quotaPattern: 'quota|rate.?limit|usage limit|RESOURCE_EXHAUSTED|too many requests|\\b429\\b|limit reached|exceeded your|insufficient (credit|balance)|try again (later|in )',
};

export const DEFAULT_CONFIG = {
  version: 1,
  controller: 'claude-code',
  providers: DEFAULT_PROVIDERS,
  roles: DEFAULT_ROLES,
  settings: DEFAULT_SETTINGS,
};
