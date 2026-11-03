import { catalogDefaults } from './catalog.js';
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
  copilot: {
    label: 'GitHub Copilot CLI',
    bin: 'copilot',
    // -p runs one prompt and exits; -s prints only the answer. Deny rules beat --allow-all-tools. File tools are
    // limited to the working folder (plus temp, plus --add-dir for conductor's prompt folder in worktree runs).
    // Not --trust-folder / COPILOT_ALLOW_ALL=true: those would load the repo's own hooks and MCP servers.
    // --disable-builtin-mcps: its GitHub MCP server could push or open PRs through the API, around the git rules.
    write: ['-p', '{prompt}', '-s', '--no-ask-user', '--no-auto-update', '--disable-builtin-mcps', '--allow-all-tools', '--add-dir', '{ioDir}',
      ...DENIED_COMMANDS.flatMap((c) => ['--deny-tool', `shell(${c})`]), '--deny-tool', 'write(.env)', '--deny-tool', 'url', '{modelArgs}'],
    // read: no write tools and no shell at all (deny beats allow); its built-in view/search tools still work
    read: ['-p', '{prompt}', '-s', '--no-ask-user', '--no-auto-update', '--disable-builtin-mcps', '--allow-all-tools', '--add-dir', '{ioDir}',
      '--deny-tool', 'write', '--deny-tool', 'shell', '--deny-tool', 'memory', '--deny-tool', 'url', '{modelArgs}'],
    modelArgs: ['--model', '{model}'],
    passEnv: ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'],
    permissions: {
      write: 'file tools limited to the project; git push/commit/reset and sudo denied; web and the built-in GitHub MCP tools off; shell commands are not OS-sandboxed (Copilot\'s --sandbox needs bubblewrap on Linux, so conductor leaves it to your Copilot settings)',
      read: 'write tools, shell, web and memory denied; only its read and search tools run',
      readOnlyEnforced: true,
    },
    install: 'npm install -g @github/copilot',
    login: 'copilot, then /login   (or set COPILOT_GITHUB_TOKEN; needs a Copilot plan)',
    docs: 'https://docs.github.com/en/copilot/how-tos/copilot-cli',
  },
  aider: {
    label: 'Aider',
    bin: 'aider',
    // one message from a file, then exit. Aider commits after every edit by default: turned off, conductor
    // decides about commits. It also loads the repo's .env by default: pointed at an empty file instead.
    // No shell commands (--no-suggest-shell-commands), so --yes-always only approves edits and adding files.
    write: ['--message-file', '{promptFile}', '--yes-always', '--no-auto-commits', '--no-dirty-commits', '--no-suggest-shell-commands',
      '--no-detect-urls', '--no-auto-lint', '--no-auto-test', '--no-check-update', '--no-show-model-warnings', '--no-pretty', '--no-stream',
      '--no-fancy-input', '--analytics-disable', '--env-file', '{devnull}', '{modelArgs}'],
    read: ['--message-file', '{promptFile}', '--dry-run', '--yes-always', '--no-auto-commits', '--no-dirty-commits', '--no-suggest-shell-commands',
      '--no-detect-urls', '--no-auto-lint', '--no-auto-test', '--no-check-update', '--no-show-model-warnings', '--no-pretty', '--no-stream',
      '--no-fancy-input', '--analytics-disable', '--env-file', '{devnull}', '{modelArgs}'],
    modelArgs: ['--model', '{model}'],
    passEnv: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'DEEPSEEK_API_KEY', 'GROQ_API_KEY', 'MISTRAL_API_KEY', 'XAI_API_KEY'],
    permissions: {
      write: 'edits files in the repo only; no shell commands; no commits (conductor turns auto-commit off); the project .env is not loaded',
      read: '--dry-run: shows the changes, writes nothing; no shell commands',
      readOnlyEnforced: true,
    },
    install: 'python -m pip install aider-install && aider-install   (or: uv tool install aider-chat)',
    login: 'no login: it uses the API key of the model you pick (e.g. ANTHROPIC_API_KEY, or conductor keys set …)',
    docs: 'https://aider.chat/docs/config/options.html',
  },
  grok: {
    label: 'Grok Build (xAI)',
    bin: 'grok',
    // official xAI CLI. --sandbox is enforced by the kernel for grok and every command it starts (Landlock/bwrap
    // on Linux, Seatbelt on macOS). strict: writes only in the project and temp, child network blocked on Linux.
    // Deny rules win even with --always-approve.
    write: ['-p', '{prompt}', '--cwd', '{cwd}', '--no-auto-update', '--sandbox', 'strict', '--always-approve',
      ...DENIED_COMMANDS.flatMap((c) => ['--deny', `Bash(${c}*)`]), '--disallowed-tools', 'web_search,web_fetch', '{modelArgs}'],
    read: ['-p', '{prompt}', '--cwd', '{cwd}', '--no-auto-update', '--sandbox', 'read-only', '--permission-mode', 'dontAsk',
      '--tools', 'read_file,grep,list_dir', '{modelArgs}'],
    modelArgs: ['--model', '{model}'],
    passEnv: ['XAI_API_KEY'],
    permissions: {
      write: 'OS sandbox (strict): writes only in the project and temp, no network for commands on Linux; git push/commit/reset and sudo denied; web tools off',
      read: 'OS sandbox (read-only) and only its read, grep and list tools',
      readOnlyEnforced: true,
    },
    install: 'curl -fsSL https://x.ai/cli/install.sh | bash',
    login: 'grok login   (or set XAI_API_KEY from console.x.ai)',
    docs: 'https://github.com/xai-org/grok-build',
  },
  kiro: {
    label: 'Kiro CLI',
    bin: 'kiro-cli',
    // headless: anything that would ask is denied. Read mode trusts only the read and search tools.
    // Write mode trusts all tools but runs commands in Kiro's sandbox (no network); --sandbox makes the run fail
    // rather than continue unsandboxed. Kiro always asks before writes to .git, which headless means denied.
    write: ['chat', '--v3', '--no-interactive', '--sandbox', '--trust-all-tools', '{modelArgs}', '{prompt}'],
    read: ['chat', '--v3', '--no-interactive', '--trust-tools=read_file,grep_search', '{modelArgs}', '{prompt}'],
    modelArgs: ['--model', '{model}'],
    passEnv: ['KIRO_API_KEY'],
    permissions: {
      write: 'commands in Kiro\'s OS sandbox with network blocked; .git writes refused; git commit/reset are not denied per run (Kiro keeps deny rules in ~/.kiro/settings/permissions.yaml), and conductor warns if a worker commits',
      read: 'only its read_file and grep_search tools; anything else is denied in headless mode',
      readOnlyEnforced: true,
    },
    install: 'curl -fsSL https://cli.kiro.dev/install | bash',
    login: 'kiro-cli login   (headless runs can also use KIRO_API_KEY, on paid plans)',
    docs: 'https://kiro.dev/docs/cli/',
  },
  goose: {
    label: 'Goose',
    bin: 'goose',
    // write: GOOSE_MODE=auto is fully autonomous and goose has no per-command or path rules, so it is not contained.
    // read: GOOSE_MODE=chat has no tools at all, so it cannot edit; conductor inlines the project context instead.
    write: ['run', '--no-session', '-q', '{modelArgs}', '-t', '{prompt}'],
    read: ['run', '--no-session', '-q', '{modelArgs}', '-t', '{prompt}'],
    modeEnv: { write: { GOOSE_MODE: 'auto' }, read: { GOOSE_MODE: 'chat' } },
    readInlineContext: true,
    modelArgs: ['--model', '{model}'],
    passEnv: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'XAI_API_KEY'],
    permissions: {
      write: 'no permission control: goose runs any command and edits any file it can reach. Only use it in a container or a worktree you can throw away',
      read: 'chat mode: no tools at all, so it cannot edit (or open files: conductor puts the project context in the prompt)',
      readOnlyEnforced: true,
    },
    install: 'curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | CONFIGURE=false bash',
    login: 'goose configure   (pick a provider and paste its key once)',
    docs: 'https://block.github.io/goose/docs/guides/goose-cli-commands',
  },
};

/** Default provider registry. type: cli | openai (any OpenAI-compatible API) | anthropic */
export const DEFAULT_PROVIDERS = {
  'antigravity-cli': { type: 'cli', preset: 'antigravity', enabled: true, model: '', notes: 'Daily driver. Google\'s agent CLI (agy), uses your Google AI Pro login. Replaced Gemini CLI, which Google retired for personal accounts on 18 June 2026.' },
  'codex-cli': { type: 'cli', preset: 'codex', enabled: true, model: '', notes: 'Daily driver. Uses your ChatGPT login or an OpenAI API key.' },
  'opencode': { type: 'cli', preset: 'opencode', enabled: true, model: 'opencode/big-pickle', notes: 'Free models through OpenCode. Good for tests and docs.' },
  'kimi-cli': { type: 'cli', preset: 'kimi', enabled: false, model: '' },
  'claude-cli': { type: 'cli', preset: 'claude', enabled: false, model: '', notes: 'Claude as a worker (spends Claude quota).' },
  'copilot-cli': { type: 'cli', preset: 'copilot', enabled: false, model: '', notes: 'GitHub Copilot as a worker (uses your Copilot plan).' },
  'grok-cli': { type: 'cli', preset: 'grok', enabled: false, model: '', notes: 'xAI Grok Build: OS-sandboxed agent. Uses your grok login or XAI_API_KEY.' },
  'kiro-cli': { type: 'cli', preset: 'kiro', enabled: false, model: '', notes: 'AWS Kiro: sandboxed commands; uses your Kiro login or KIRO_API_KEY.' },
  'goose': { type: 'cli', preset: 'goose', enabled: false, model: '', notes: 'Not contained in write roles: use only in a throwaway worktree or container.' },
  'aider': { type: 'cli', preset: 'aider', enabled: false, model: '', notes: 'Edits with any model you have a key for. Set a model, e.g. sonnet, gpt-6-astra or openrouter/<id>.' },


  // chat APIs: built from the catalog (src/catalog.js), under their original names
  ...catalogDefaults(),
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
  docs: ['openrouter-free', 'kilo-free', 'opencode', 'gemini-api', 'antigravity-cli'],
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
