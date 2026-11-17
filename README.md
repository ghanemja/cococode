# coco

A coding agent for your terminal that runs on **local models**. It reads and edits files, runs commands, searches your code and checks its own work, using a model served by Ollama, LM Studio, llama.cpp, vLLM or any OpenAI-compatible endpoint. Nothing leaves your machine unless you ask it to fetch a web page.

```
✻ coco v0.1.0
  qwen3-coder:30b · ollama · 32k context
  ~/code/my-project

> fix the failing test in the parser

● Bash(npm test)
  └ Exit code 1
● Read(src/parser.ts)
  └ Read 212 lines
● Edit(src/parser.ts)
  └ Replaced 1 occurrence (+3 -1)
● Bash(npm test)
  └ 14 lines of output

● Fixed. `parseHeader` dropped the last field when the line had no trailing
  newline (src/parser.ts:88). All 42 tests pass now.
```

It has no runtime dependencies: a clone and Node.js are all it needs.

## Install

Requires Node.js 22.18 or newer and a running model server.

```bash
git clone https://github.com/ghanemja/cococode.git
cd cococode
npm install
npm link
```

`npm link` puts `coco` on your PATH. You can also run it in place with `node bin/coco.js`.

## Quick start

Start a model server and pull a model that supports tool calling:

```bash
ollama pull qwen3-coder
```

Then, in a project directory:

```bash
coco
```

coco finds the server, asks which model to use the first time, and remembers the answer. To run one prompt and exit:

```bash
coco -p "explain what src/index.ts does"
```

```bash
git diff | coco -p "write a commit message for this"
```

Check your setup at any time:

```bash
coco doctor
```

## Choosing a model

The model matters more than anything else. Three things to get right:

**Tool calling.** The agent works by calling tools. Models trained for it (Qwen3 / Qwen3-Coder, Devstral, Llama 3.1+, Mistral, gpt-oss, Gemma 4) are far more reliable. Models without native tool calling still work through a text protocol, which coco switches to automatically, but expect more mistakes.

**Context window.** The system prompt and tool definitions take about 3k tokens before any of your code is read. coco asks for a **32k** window by default and is comfortable at 64k:

```bash
coco --context 65536
```

On Ollama this matters especially. Ollama chooses a default context from your GPU memory (4k on cards under 24 GB), and a prompt that does not fit is truncated silently, so the model loses its instructions and tools without any error. coco talks to Ollama's native API and sets `num_ctx` on every request, which avoids this. If you point coco at Ollama's `/v1` endpoint instead, it cannot set the context and will warn you.

For LM Studio and llama.cpp the context is fixed when the model is loaded; set it there (`--ctx-size 32768` for `llama-server`). coco reads the loaded size and plans around it.

**Size.** Small models (under ~8B parameters) can handle single-step tasks but lose the thread on multi-step work. Use the largest model your hardware runs at a usable speed.

## Model servers

| Server | How coco finds it | Notes |
| --- | --- | --- |
| Ollama | `http://127.0.0.1:11434`, or `OLLAMA_HOST` | Native API; context window set per request |
| LM Studio | `http://127.0.0.1:1234/v1` | Start the local server from the Developer tab |
| llama.cpp | `http://127.0.0.1:8080/v1` | Run `llama-server` with `--jinja` |
| vLLM | `http://127.0.0.1:8000/v1` | |
| Jan, KoboldCpp, TabbyAPI | their default ports | |
| Anything OpenAI-compatible | `--base-url http://host:port/v1` | Add `--api-key` if it needs one |

Running servers are detected automatically. To be explicit:

```bash
coco --provider lmstudio --model qwen/qwen3-coder-30b
```

```bash
coco --base-url http://gpu-box:8000/v1 --model my-model
```

`coco models` lists every model on every server it can reach.

## Using it

Type a request and press enter. While the model works you can keep typing; messages are queued and delivered when it reaches a stopping point.

| Input | What it does |
| --- | --- |
| `@path` | Attach a file or directory listing (tab completes) |
| `/command` | Run a slash command (tab completes) |
| `!command` | Run a shell command yourself; the model sees the output |
| `#note` | Save a note to a memory file |
| `\` + enter, alt+enter, ctrl+j | New line |

| Key | What it does |
| --- | --- |
| esc | Interrupt the model. Twice on an empty prompt: rewind |
| shift+tab | Cycle permission mode: ask → accept edits → plan |
| ctrl+o | Toggle verbose tool output |
| ctrl+c | Clear input or interrupt; twice to exit |
| up / down | Prompt history |
| ctrl+l | Clear the screen |

### Slash commands

| Command | Purpose |
| --- | --- |
| `/help` | Commands and shortcuts |
| `/model [name]` | Switch model |
| `/mode [name]`, `/plan` | Change permission mode |
| `/permissions [allow\|deny\|ask\|remove <rule>]` | View or edit permission rules |
| `/context` | What is using the context window |
| `/compact [focus]` | Summarize the conversation to free context |
| `/clear` | Start a new conversation |
| `/resume [id]` | Continue an earlier conversation |
| `/rewind` | Go back to an earlier message and/or undo file edits |
| `/init` | Generate a `COCO.md` for the project |
| `/memory` | Edit memory files |
| `/review [target]` | Review uncommitted changes or a branch |
| `/usage` | Tokens, speed and duration for the session |
| `/status`, `/doctor [probe]` | What is configured, and whether it is healthy; `probe` tests the model with live tool calls |
| `/config [get\|set]` | View or change settings |
| `/think [on\|off\|level]` | Model reasoning |
| `/output-style [name]` | default, explanatory, learning, or your own |
| `/agents`, `/skills`, `/hooks`, `/mcp` | List what is installed |
| `/todos`, `/bashes` | The task list and background shells |
| `/add-dir <path>` | Allow work in another directory |
| `/export [file]`, `/copy` | Save the conversation as Markdown; copy the last reply |
| `/rename <name>`, `/branch [name]` | Name the session; continue in a copy of it |
| `/diff` | Uncommitted changes in the project |
| `/btw <question>` | A side question that stays out of the conversation |
| `/recap` | Summarize the session so far |
| `/cd <dir>` | Change the working directory |
| `/autocompact [on\|off]` | Automatic summarizing |
| `/security-review` | Review pending changes for security problems |
| `/reload-skills` | Re-read commands, skills, agents and memory from disk |
| `/verbose`, `/exit` | |

## Tools

| Tool | What it does |
| --- | --- |
| `Read` | Read files (text, notebooks, images for vision models), with paging |
| `Edit` | Replace text in a file; tolerates whitespace mismatches |
| `Write` | Create or overwrite a file |
| `NotebookEdit` | Edit Jupyter notebook cells |
| `Bash` | Run shell commands; working directory persists; background mode |
| `BashOutput`, `KillShell` | Follow or stop background commands |
| `Glob`, `Grep` | Find files and search contents, respecting `.gitignore` (uses ripgrep when installed) |
| `WebFetch`, `WebSearch` | Fetch a page as Markdown; search (DuckDuckGo, or your SearXNG) |
| `TodoWrite` | Keep a task list for multi-step work |
| `Agent` | Delegate a task to a subagent with its own context |
| `AskUserQuestion` | Ask you to choose between options |
| `EnterPlanMode`, `ExitPlanMode` | Switch to planning; present a plan for approval |
| `Skill` | Load a skill's instructions |
| `mcp__server__tool` | Tools from MCP servers |

## Permissions

By default coco asks before it changes anything.

- **Reads** inside the project are allowed. Outside it, coco asks.
- **Edits** ask, showing the diff first.
- **Shell commands** ask, except ones that only read (`ls`, `git status`, `grep` and similar) and stay inside the project. Anything coco cannot analyze in advance, such as command substitution or a variable in a path, asks.
- **Web and MCP tools** ask the first time.
- **Files that decide what runs on your machine** always ask, in every mode short of `bypassPermissions`: `.git/`, coco and Claude settings files, `.mcp.json`, shell startup files and `~/.ssh`. A general `Edit` rule does not cover them; a rule has to name the file.

Each prompt offers "yes", "yes, and don't ask again" (which saves a rule), or "no" with room to say what to do instead.

Modes, cycled with shift+tab or set with `--permission-mode`:

| Mode | Behaviour |
| --- | --- |
| `default` | Ask as described above |
| `acceptEdits` | File edits in the project are applied without asking |
| `plan` | Read-only. The model researches, then presents a plan for approval |
| `dontAsk` | Anything not already allowed is refused |
| `bypassPermissions` | Never ask. Only for sandboxes and containers |

Rules live in settings files and take the form `Tool` or `Tool(specifier)`:

```json
{
  "permissions": {
    "allow": ["Bash(npm test:*)", "Bash(git diff *)", "Edit(src/**)"],
    "ask": ["Bash(git push:*)"],
    "deny": ["Read(.env)", "Read(secrets/**)", "WebFetch"]
  }
}
```

Deny beats ask beats allow. Path rules follow gitignore conventions (`//abs`, `~/home`, `/from-project-root`, `relative`). A compound command such as `a && b` is allowed only if every part is, and an ask or deny rule on any part applies to the whole line. `Edit` rules cover every tool that changes files and `Read` rules cover `Glob` and `Grep`; a bare `Write`, `NotebookEdit`, `Glob` or `Grep` rule means just that tool. `Read` and `Edit` deny rules also block shell commands that name those paths, on a best-effort basis: they are a guard against accidents, not a sandbox.

## Memory

coco loads instruction files into every session:

- `~/.coco/COCO.md` for all your projects
- `COCO.md` (or `AGENTS.md`) in the project, and in each directory down to where you started
- `COCO.local.md` for notes you keep out of git

Files can pull in others with `@path/to/file` (up to five levels deep). Run `/init` to have the model write a first `COCO.md`, `/memory` to edit, or start a line with `#` to add a note.

**Rules.** Every Markdown file under `.coco/rules/` (and `~/.coco/rules/`) is loaded too. A rule with `paths` in its front matter is held back until the model works on a matching file:

```markdown
---
paths: src/api/**/*.ts
---
Handlers validate their input with zod before touching the database.
```

**Nested instructions.** A `COCO.md` in a subdirectory is not loaded at start. It is delivered the first time the model reads or edits a file below that directory, so a large repository does not pay for instructions it never needs. `claudeMdExcludes` (a list of globs) skips files; `node_modules` is skipped by default.

**Auto memory.** The model keeps its own notes for each repository in `~/.coco/projects/<project>/memory/`. The first 200 lines (or 25 KB) of `MEMORY.md` there are loaded at the start of every session, and the model can read and write that directory without asking. Turn it off with `"autoMemoryEnabled": false`.

After the conversation is summarized, the project's memory files, the approved plan, the task list, up to five recently read files and the skills in use are put back, so a long session does not forget its instructions.

## Extending it

**Custom commands.** A Markdown file at `.coco/commands/fix-issue.md` becomes `/fix-issue`. Subdirectories become namespaces (`/git:sync`).

```markdown
---
description: Fix a GitHub issue
argument-hint: <issue number>
allowed-tools: Bash(gh issue view:*)
---
Fix issue #$1. Current branch: !`git branch --show-current`
```

`$ARGUMENTS` and `$1`…`$9` are filled in; `` !`cmd` `` (or a fenced block opened with three backticks and `!`) is replaced by the command's output when `allowed-tools` permits it.

**Subagents.** `.coco/agents/reviewer.md` defines an agent the model can delegate to. Built in: `general-purpose`, `explore` (read-only search) and `plan`.

```markdown
---
name: reviewer
description: Reviews a change for bugs. Use after writing code.
tools: Read, Grep, Glob, Bash
disallowedTools: Write
maxTurns: 30
skills: house-style
---
You are a meticulous code reviewer...
```

`tools` and `disallowedTools` limit what the agent can use, `model` picks another model for it, `maxTurns` bounds it, `skills` loads those skills into it from the start, and `omitClaudeMd: true` leaves the project memory out. Names are matched without regard to case. `--agents '<json>'` defines agents for one run, and `--agent <name>` (or the `agent` setting) runs the main conversation as that agent, with its prompt, tools and model. A subagent cannot start further subagents.

**Skills.** `.coco/skills/<name>/SKILL.md` holds instructions the model loads when a task matches the skill's description. Skills are also available as `/name`.

```markdown
---
description: Cut a release. Use when asked to publish a new version.
argument-hint: <version>
allowed-tools: Bash(git tag *), Bash(npm version *)
disable-model-invocation: true
---
Release $0. Notes template: ${COCO_SKILL_DIR}/notes.md
Current tags: !`git tag --list`
```

| Field | Meaning |
| --- | --- |
| `description`, `when_to_use` | What the model reads when deciding whether to load the skill |
| `argument-hint`, `arguments` | Shown in completion; `arguments: [issue, branch]` names them for `$issue`, `$branch` |
| `allowed-tools` | Rules approved for the rest of the session once the skill is used; also what its inline `!` commands may run |
| `disable-model-invocation: true` | Only you can run it, as `/name` |
| `user-invocable: false` | Only the model can load it; hidden from `/` completion |
| `context: fork`, `agent` | Run the skill in a subagent (of the named type) and return its report |

In a skill, `$ARGUMENTS` is everything typed after the name, `$0`, `$1`… and `$ARGUMENTS[0]`… are single arguments counted from zero, and `${COCO_SKILL_DIR}`, `${COCO_SESSION_ID}` and `${COCO_PROJECT_DIR}` are filled in (the `CLAUDE_` spellings work as well). Write `\$1` for a literal `$1`.

**Output styles.** `.coco/output-styles/<name>.md` adds to the system prompt; select with `/output-style`.

**Hooks.** Commands that run at points in the agent's work, configured in settings:

```json
{
  "hooks": {
    "PostToolUse": [
      { "matcher": "Edit|Write", "hooks": [{ "type": "command", "command": "npx prettier --write \"$(jq -r .tool_input.file_path)\"" }] }
    ]
  }
}
```

Events: `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PostToolUseFailure`, `UserPromptSubmit`, `Stop`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`, `SessionStart`, `SessionEnd`, `Notification`. A hook receives JSON on stdin. Exit code 2 blocks the action and feeds stderr back to the model; JSON on stdout can allow, deny or rewrite a tool call (`hookSpecificOutput.permissionDecision`, `updatedInput`), answer a permission prompt, add context, or stop the turn (`"continue": false`).

| Handler | What it does |
| --- | --- |
| `{ "type": "command", "command": "..." }` | Runs a shell command |
| `{ "type": "http", "url": "...", "headers": {...}, "allowedEnvVars": [...] }` | POSTs the event; a 2xx reply's body is read like a command's output. Headers may use `$NAME` for the listed variables only |
| `{ "type": "prompt", "prompt": "...", "model": "..." }` | Asks the model to judge the event; it answers `{"ok": true}` or `{"ok": false, "reason": "..."}` |

Any handler can carry `"if": "Bash(git push *)"` to run only for matching tool calls, and `"timeout"` in seconds. Defaults follow Claude Code: 600 seconds for a hook, 30 for `UserPromptSubmit` and prompt hooks, and a shared 1.5 seconds at `SessionEnd`. A matcher made of names (`Edit|Write`) matches exactly; anything else is a regular expression. Hook output added to the conversation is capped at 10,000 characters. A `Stop` hook that keeps blocking is overridden after eight rounds, so it cannot hold a turn open forever. `"disableAllHooks": true` switches hooks off.

**MCP servers.** Connect tools over the Model Context Protocol (stdio, streamable HTTP or SSE):

```bash
coco mcp add files -- npx -y @modelcontextprotocol/server-filesystem ~/Documents
```

```bash
coco mcp add --transport http docs https://example.com/mcp
```

Project servers go in `.mcp.json`. Each tool definition costs context, so connect only what you use.

**Status line.** Set `statusLine` to a command; it receives session JSON on stdin and its first line of output is shown under the prompt.

All of these are also read from `.claude/` and `CLAUDE.md` when present, so an existing Claude Code setup (commands, agents, skills, hooks, permission rules, `.mcp.json`) carries over. Turn that off with `"claudeCompat": false`.

The first time a project defines hooks, MCP servers or a status line, coco asks whether you trust it before running any of them.

## Sessions

Conversations are saved under `~/.coco/projects/`.

```bash
coco --continue
```

```bash
coco --resume
```

`--continue` picks up the most recent conversation in the directory; `--resume` shows a list (or takes an id). `/rewind` returns to an earlier message and can undo the file edits made since. It restores edits made with the file tools, not side effects of shell commands.

When the context window fills up, coco first clears old tool output, then summarizes the conversation and carries on. `/compact` does it on demand; `/context` shows where the space is going.

## Headless use

```bash
coco -p "run the tests and fix what fails" --permission-mode acceptEdits --allowedTools "Bash(npm test:*)"
```

`-p` cannot prompt, so anything that would need approval is refused unless a rule or mode allows it. It also cannot show the trust question, so a project's hooks and MCP servers are loaded as configured: run it only in projects you trust.

| Flag | Purpose |
| --- | --- |
| `--output-format text\|json\|stream-json` | Final text, one JSON result, or a JSON event per line |
| `--input-format stream-json` | Read one JSON user message per line from stdin and run a turn for each, in one session |
| `--json-schema <schema\|file>` | The final answer must be JSON matching the schema; a reply of the wrong shape is sent back up to two times. The value is in `structured_output` |
| `--include-partial-messages` | With `stream-json`: also emit text as it streams |
| `--max-turns <n>` | Stop after n model turns |
| `--fallback-model <names>` | Models to try, in order, when the main one fails |
| `--agents <json>`, `--agent <name>` | Define subagents for the run; run as one |
| `--name <name>`, `--session-id <uuid>`, `--fork-session` | Name the session, fix its id, or continue in a copy |
| `--bare` | Ignore memory files, hooks, MCP servers, skills, commands and custom agents |
| `--setting-sources user,project,local` | Which settings files to read |
| `--debug [api,tools]`, `--debug-file <path>` | Log requests, responses and tool calls |
| `--allowedTools`, `--disallowedTools` | Permission rules for this run |
| `--tools <names>` | Limit the tool set |
| `--system-prompt`, `--append-system-prompt` | Replace or extend the system prompt |
| `--image <files>` | Attach images, for models that accept them |
| `--no-session-persistence` | Do not save a transcript |

Run `coco --help` for the full list. The JSON result carries `is_error`, `num_turns`, `usage`, `permission_denials` and `session_id`; `stream-json` also reports retries (`api_retry`) and compaction. A run ended by SIGTERM exits with 143.

## Configuration

Settings are JSON, merged in this order (later wins):

1. `~/.coco/settings.json`
2. `.coco/settings.json` (shared with the team)
3. `.coco/settings.local.json` (yours; keep it out of git)
4. `--settings <file or JSON>`
5. Environment variables, then command-line flags

```bash
coco config set model qwen3-coder:30b
```

```bash
coco config set permissions.defaultMode acceptEdits --scope project
```

| Key | Default | Meaning |
| --- | --- | --- |
| `provider`, `model`, `baseUrl`, `apiKey` | detected | Which server and model |
| `providers` | | Named endpoints: `{ "name": { "type": "ollama"\|"openai", "baseUrl": "..." } }` |
| `contextWindow` | 32768 or detected | Tokens to plan for (and to request from Ollama) |
| `maxOutputTokens` | a quarter of the window, up to 8192 | Output limit per response |
| `toolMode` | `auto` | `native`, `prompt` (text protocol) or `auto` |
| `thinking` | model default | `true`, `false`, or a level such as `"low"` |
| `temperature` | server default | |
| `keepAlive` | `30m` | How long Ollama keeps the model loaded |
| `permissions` | | `allow`, `ask`, `deny`, `defaultMode`, `additionalDirectories` |
| `hooks`, `env`, `statusLine`, `outputStyle` | | See above |
| `autoCompact`, `compactThreshold` | `true`, `0.8` | When to summarize |
| `maxToolOutputChars` | 30000, less on small context windows | Largest tool result kept in the conversation; longer output is saved to a file the model can read |
| `maxRetries` | 10 | Retries for a failed model request |
| `requestTimeoutMs` | 600000 | How long a request may go without any output |
| `fallbackModel` | | Models to try, in order, when the main one fails |
| `agent` | | Run the main conversation as this agent |
| `autoMemoryEnabled`, `claudeMdExcludes` | `true`, | See Memory |
| `disableAllHooks` | `false` | |
| `webSearch` | DuckDuckGo | `{ "provider": "searxng", "url": "http://localhost:8888" }` |
| `claudeCompat` | `true` | Read `.claude/` and `CLAUDE.md` |
| `bell` | `false` | Ring when a turn ends or approval is needed |

Environment: `COCO_MODEL`, `COCO_PROVIDER`, `COCO_BASE_URL`, `COCO_API_KEY`, `COCO_CONTEXT_WINDOW`, `COCO_MAX_RETRIES`, `COCO_REQUEST_TIMEOUT_MS`, `COCO_CONFIG_DIR`, `CLAUDE_CONFIG_DIR`, `OLLAMA_HOST`, `OPENAI_BASE_URL`, `OPENAI_API_KEY`. To use the web tools behind a proxy, set `NODE_USE_ENV_PROXY=1`.

## Built for local models

Local models fail in ways hosted ones mostly do not. coco is built around them:

- **Silent context truncation.** The context window is pinned on Ollama, token estimates are calibrated against what the server reports, and old tool output is cleared before the window fills.
- **Tool calls written as text.** `<tool_call>` blocks, Qwen-style XML, `<function=…>`, `[TOOL_CALLS]` and bare JSON are recognized in the reply and executed, instead of being mistaken for a finished answer.
- **Nearly-right arguments.** Numbers sent as strings, JSON with trailing commas and misnamed tools (`read_file` for `Read`) are repaired; anything else gets an error that names the parameter to fix.
- **Edits that miss by whitespace.** `Edit` falls back to matching while ignoring indentation or trailing spaces when that identifies exactly one place, and re-indents the replacement.
- **Loops.** The third identical tool call in a row is refused with a message telling the model to change approach.
- **Reasoning that eats the output budget.** An empty reply cut off at the token limit is retried with a larger budget.
- **Claiming work that was not done.** Tool results state what changed (the edited lines, the exit code), so the model can check itself and so can you.

### Check your model first

```bash
coco doctor --probe
```

This sends three small requests and reports whether the model calls a tool when told to, uses the result, and fills in typed arguments, along with its speed and the context window in effect. When native tool calling fails but the text protocol works, it says so and gives the setting to change. A model that fails here will not do well on real tasks, whatever the agent around it does.

### Recovering instead of stopping

A turn should survive the ordinary failures of a long session. These follow what Claude Code documents, with the numbers it uses:

| Failure | What coco does |
| --- | --- |
| Connection refused or reset, timeout, HTTP 408/425/429/5xx, "model is loading" | Retries up to 10 times, waiting 0.5 s and doubling up to 32 s (`maxRetries`) |
| A request produces no output for 10 minutes | Aborts it and tries once more (`requestTimeoutMs`) |
| A stream ends having produced nothing | Asks again without streaming |
| The connection drops mid-reply | Keeps the text received, runs tool calls that arrived complete, and tells the model to continue from where it stopped |
| A reply is cut off by the output limit | Continues it automatically, up to twice. A tool call cut off mid-arguments is never run: the model is told to write in smaller pieces |
| The model keeps failing for another reason | Switches to the next `fallbackModel` for the rest of the turn |
| A tool result is too large | Saves it to a file and shows the model the start, with the path |
| The context fills up | Clears old tool output, then summarizes and re-attaches memory, plan, tasks, recent files and skills. If summarizing stops helping three times in a row, it stops trying and says so |
| The same tool call three times in a row | Refuses it and tells the model to change approach |
| A `Stop` hook that never lets go | Overridden after eight rounds |

## What is not here

coco aims to match the day-to-day experience of Claude Code, not every feature. Not included: IDE extensions, a plugin marketplace, OS-level sandboxing of shell commands, vim key bindings, pasting images from the clipboard, and cloud or remote sessions. Windows works through a POSIX shell (WSL or Git Bash) and is less tested than Linux and macOS.

## Development

```bash
npm test
```

```bash
npm run typecheck
```

The sources are TypeScript that Node runs directly, so there is no build step while developing. `npm run build` compiles to `dist/` for publishing.

| Path | Contents |
| --- | --- |
| `src/providers/` | Ollama and OpenAI-compatible clients, text tool-call parsing, server detection |
| `src/agent/` | The agent loop, system prompt, token accounting, compaction |
| `src/tools/` | The built-in tools |
| `src/permissions/` | Rules, shell command analysis, permission modes |
| `src/core/controller.ts` | Wires a session together; shared by the UI and headless mode |
| `src/ui/` | Terminal UI: screen, editor, key decoding, Markdown, dialogs |
| `src/mcp/`, `src/hooks/`, `src/memory/`, `src/session/`, `src/config/` | What the names say |
| `test/` | Unit tests, a scripted mock model server, end-to-end and terminal UI tests |

The terminal UI tests drive the real program in a pseudo-terminal and need `python3` with `pyte` (`pip install pyte`); they are skipped without it.
