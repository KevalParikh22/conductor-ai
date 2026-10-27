// Built-in knowledge: how to drive each CLI agent, default providers, roles and controllers.
// Everything here can be overridden in config (global or per project).

/**
 * CLI agent presets. Arg tokens:
 *   {prompt}      the full prompt text (avoid for very long prompts; prefer stdin or {promptFile})
 *   {promptFile}  path to a file holding the prompt
 *   {outFile}     path the CLI may write its final answer to (read back if non-empty)
 *   {modelArgs}   expands to `modelArgs` with {model} filled in, or to nothing when no model is set
 * `stdin: true` pipes the prompt to the process.
 */
export const CLI_PRESETS = {
  gemini: {
    label: 'Gemini CLI',
    bin: 'gemini',
    stdin: true, // -p text is appended to stdin, so the long prompt goes through stdin
    write: ['{modelArgs}', '--approval-mode', 'yolo', '-p', 'Follow the instructions above exactly.'],
    read: ['{modelArgs}', '--approval-mode', 'default', '-p', 'Follow the instructions above exactly.'],
    modelArgs: ['-m', '{model}'],
    install: 'npm install -g @google/gemini-cli',
    login: 'gemini   (choose "Login with Google"), or set GEMINI_API_KEY',
    docs: 'https://github.com/google-gemini/gemini-cli',
  },
  codex: {
    label: 'Codex CLI',
    bin: 'codex',
    stdin: true, // "-" = read prompt from stdin
    write: ['exec', '--skip-git-repo-check', '--sandbox', 'workspace-write', '{modelArgs}', '-o', '{outFile}', '-'],
    read: ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '{modelArgs}', '-o', '{outFile}', '-'],
    modelArgs: ['-m', '{model}'],
    install: 'npm install -g @openai/codex',
    login: 'codex login   (or: printenv OPENAI_API_KEY | codex login --with-api-key)',
    docs: 'https://developers.openai.com/codex',
  },
  opencode: {
    label: 'OpenCode',
    bin: 'opencode',
    write: ['run', '--auto', '{modelArgs}', '-f', '{promptFile}', 'Follow the instructions in the attached file exactly.'],
    read: ['run', '{modelArgs}', '-f', '{promptFile}', 'Follow the instructions in the attached file exactly. Do not modify any files.'],
    modelArgs: ['-m', '{model}'],
    install: 'curl -fsSL https://opencode.ai/install | bash   (or: npm install -g opencode-ai)',
    login: 'opencode auth login',
    docs: 'https://opencode.ai/docs/cli/',
  },
  kimi: {
    label: 'Kimi Code CLI',
    bin: 'kimi',
    write: ['{modelArgs}', '-p', '{prompt}'],
    read: ['{modelArgs}', '-p', '{prompt}'],
    modelArgs: ['-m', '{model}'],
    install: 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash   (or: uv tool install --python 3.13 kimi-cli)',
    login: 'kimi, then /login',
    docs: 'https://www.kimi.com/code/docs/en/kimi-code-cli/getting-started.html',
  },
  claude: {
    label: 'Claude Code (as a worker)',
    bin: 'claude',
    stdin: true,
    write: ['-p', '{modelArgs}', '--permission-mode', 'acceptEdits'],
    read: ['-p', '{modelArgs}', '--permission-mode', 'plan'],
    modelArgs: ['--model', '{model}'],
    install: 'npm install -g @anthropic-ai/claude-code',
    login: 'claude   (then /login)',
    docs: 'https://code.claude.com/docs',
  },
};

/** Default provider registry. type: cli | openai (any OpenAI-compatible API) | anthropic */
export const DEFAULT_PROVIDERS = {
  'gemini-cli': { type: 'cli', preset: 'gemini', enabled: true, model: '', notes: 'Daily driver. Uses your Google login (Gemini Pro quota) or GEMINI_API_KEY.' },
  'codex-cli': { type: 'cli', preset: 'codex', enabled: true, model: '', notes: 'Daily driver. Uses your ChatGPT login or an OpenAI API key.' },
  'opencode': { type: 'cli', preset: 'opencode', enabled: true, model: 'opencode/big-pickle', notes: 'Free models through OpenCode. Good for tests and docs.' },
  'kimi-cli': { type: 'cli', preset: 'kimi', enabled: false, model: '' },
  'claude-cli': { type: 'cli', preset: 'claude', enabled: false, model: '', notes: 'Claude as a worker (spends Claude quota).' },

  'gemini-api': { type: 'openai', enabled: true, baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKeyEnv: 'GEMINI_API_KEY', model: 'gemini-3.8-flash', notes: 'Free tier from Google AI Studio.' },
  'openrouter-free': { type: 'openai', enabled: true, baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY', model: 'openrouter/free', notes: 'Any ":free" model. 20 req/min, 50/day (1000/day after $10 credit).' },
  'openai-api': { type: 'openai', enabled: false, baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY', model: 'gpt-6-luna' },
  'kimi-api': { type: 'openai', enabled: false, baseUrl: 'https://api.moonshot.ai/v1', apiKeyEnv: 'MOONSHOT_API_KEY', model: 'kimi-latest' },
  'deepseek-api': { type: 'openai', enabled: false, baseUrl: 'https://api.deepseek.com/v1', apiKeyEnv: 'DEEPSEEK_API_KEY', model: 'deepseek-chat' },
  'groq-api': { type: 'openai', enabled: false, baseUrl: 'https://api.groq.com/openai/v1', apiKeyEnv: 'GROQ_API_KEY', model: '' },
  'claude-api': { type: 'anthropic', enabled: false, baseUrl: 'https://api.anthropic.com', apiKeyEnv: 'ANTHROPIC_API_KEY', model: 'claude-sonnet-5-5' },
  'ollama': { type: 'openai', enabled: false, baseUrl: 'http://localhost:11434/v1', apiKeyEnv: '', model: 'qwen3-coder', notes: 'Local model, free, private.' },
  'lmstudio': { type: 'openai', enabled: false, baseUrl: 'http://localhost:1234/v1', apiKeyEnv: '', model: '' },
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
  build: ['gemini-cli', 'codex-cli', 'opencode'],
  fix: ['codex-cli', 'gemini-cli', 'opencode'],
  test: ['opencode', 'openrouter-free', 'gemini-cli'],
  docs: ['openrouter-free', 'opencode', 'gemini-api', 'gemini-cli'],
  review: ['codex-cli', 'gemini-cli', 'gemini-api'],
  ask: ['gemini-cli', 'gemini-api', 'openrouter-free'],
};

/** Who plans, reviews and commits. `conductor init` writes the matching instruction files. */
export const CONTROLLERS = {
  'claude-code': { label: 'Claude Code', file: 'CLAUDE.md' },
  'gemini-cli': { label: 'Gemini CLI', file: 'GEMINI.md' },
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
