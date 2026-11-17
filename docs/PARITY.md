# coco compared with Claude Code

This is a feature-by-feature comparison against the Claude Code documentation (code.claude.com/docs: CLI reference, commands, tools, permissions, settings, hooks, skills, subagents, memory, MCP, interactive mode, headless mode) and its changelog, as read on 2026-11-17. A few of the longer pages were read only in part, so treat the Claude Code side as close to complete rather than exhaustive.

## Short answer

coco does **not** match all of Claude Code. Claude Code documents about 80 command-line flags, 110 slash commands, 45 tools, 33 hook events and 330 settings; a large share of that is tied to Anthropic's cloud, desktop and IDE products or to the hosted API, and has no meaning for a program that talks to a model on your own machine.

What coco does match is the core loop and the conventions around it: the tools, the permission system, memory files, custom commands, skills, subagents, hooks, MCP, sessions with resume and rewind, headless mode, and the documented recovery behaviour. Files written for Claude Code (`CLAUDE.md`, `.claude/commands`, `.claude/agents`, `.claude/skills`, `.claude/settings.json` hooks and permission rules, `.mcp.json`) are read as they are.

## What has been verified, and what has not

- **Verified:** every behaviour listed as matched below has automated tests. They run the real program against a scripted model server that speaks both wire formats (Ollama and OpenAI-compatible), and drive the terminal UI through a pseudo-terminal.
- **Not verified:** coco has never been run against a real model. The environment it was built in could not run one. The scripted server reproduces failures (dropped connections, cut-off replies, malformed tool calls, tool calls written as text), but it cannot reproduce a real model's judgment.

That gap matters. Much of what makes Claude Code effective is the model behind it, and no agent program can make a small local model reason like a large hosted one. What the program can do is avoid wasting the model's ability: keep the context window from being silently truncated, accept tool calls in whatever form the model writes them, repair near-miss arguments, and recover from failures instead of ending the turn. To find out where your own model stands, run:

```bash
coco doctor --probe
```

It sends three small requests and reports whether the model calls a tool when told to, uses the result, and fills in typed arguments.

## Recovery behaviour

These are the mechanisms Claude Code documents for keeping a turn alive. All are implemented and tested.

| Claude Code | coco |
| --- | --- |
| Failed requests retried up to 10 times, starting at 0.5 s and doubling to a 32 s cap; shown as "Retrying in…" and as `api_retry` events | Same numbers, same events. Applies to refused or reset connections, timeouts, HTTP 408/425/429/5xx and a server still loading the model. `maxRetries` changes the count |
| Request timeout of 600 s | Same (`requestTimeoutMs`), measured as time without any output, because a local model may take minutes to load. A timed-out request is tried once more |
| Falls back to a non-streaming request when streaming fails | Same, when a stream ends having produced nothing |
| A dropped stream keeps what arrived | Text is kept, complete tool calls are run, and the model is told to continue |
| `--fallback-model` | Same, with several models in order; used for the rest of the turn |
| A reply cut off by the output limit is continued | Same, up to twice. A tool call cut off mid-arguments is never run |
| Auto-compaction, with a stop after repeated failures | Same: old tool output is cleared first, then the conversation is summarized. After three compactions in a row that do not help, it stops and says so |
| After compaction: project instructions, the plan, recent files and invoked skills are restored | Same: memory files, the approved plan, the task list, up to five recently read files and the skills in use, within a budget scaled to the context window. `SessionStart` hooks run again with source `compact` |
| Tool output above 30,000 characters is saved to a file with a preview | Same. The limit shrinks on small context windows so one result cannot fill the window |
| A file must be read before it is edited; a file changed since is re-read | Same, see "File safety" below |
| A command that exceeds its timeout keeps running in the background | Same, see "File safety" below |
| Hook timeouts: 600 s, 30 s for prompt hooks, 1.5 s shared at session end; output capped at 10,000 characters | Same |
| A `Stop` hook cannot block for ever | Same: overridden after eight rounds |
| MCP servers that fail or disconnect do not end the session; reconnection with backoff | Same, see "MCP" below |
| Exit code 143 on SIGTERM in headless mode | Same |

Beyond Claude Code, for failures specific to local models: the context window is set explicitly on every Ollama request; tool calls written as text (`<tool_call>`, Qwen XML, `<function=…>`, `[TOOL_CALLS]`, bare JSON) are recognized; arguments of nearly the right type are coerced; misnamed tools are mapped; the third identical tool call in a row is refused; an empty reply that used its whole budget on reasoning is retried with a larger one.

## Area by area

**Matched** means the documented behaviour is implemented. **Partial** means the common use works and the listed parts do not. **Missing** means it could exist in a local tool and does not yet.

### Command line

| | |
| --- | --- |
| Matched | `-p`, `-c`, `-r` (id, prefix or name), `--model`, `--permission-mode`, `--dangerously-skip-permissions`, `--allowedTools`, `--disallowedTools`, `--tools`, `--add-dir`, `--system-prompt[-file]`, `--append-system-prompt[-file]`, `--fallback-model`, `--effort`, `--agent`, `--agents`, `--name`, `--session-id`, `--fork-session`, `--mcp-config`, `--strict-mcp-config`, `--settings`, `--setting-sources`, `--bare` / `--safe-mode`, `--disable-slash-commands`, `--output-format`, `--input-format`, `--json-schema`, `--include-partial-messages`, `--max-turns`, `--no-session-persistence`, `--debug`, `--debug-file`, `--verbose`, `--version`; subcommands `doctor` and `mcp add / add-json / list / get / remove` |
| Missing | `--worktree`, `--init` / `--maintenance` (the `Setup` hook), `--permission-prompt-tool`, `--replay-user-messages`, `--include-hook-events`, `--append-subagent-system-prompt`, `--bg` and the background-session commands (`agents`, `attach`, `logs`, `stop`), `claude import`, `claude purge` |
| Not applicable | Anything for accounts, billing, cloud sessions, the desktop app, Chrome, IDEs, plugins or remote control (`auth`, `--cloud`, `--chrome`, `--ide`, `--remote-control`, `--max-budget-usd`, `--betas`, `update`, `install`…) |
| Added | `--provider`, `--base-url`, `--api-key`, `--context`, `--tool-mode`, `--image`; subcommands `models`, `sessions`, `config`, `doctor --probe` |

### Slash commands

| | |
| --- | --- |
| Matched | `/help`, `/clear`, `/compact`, `/context`, `/usage` (`/cost`, `/stats`), `/status`, `/doctor`, `/model`, `/plan`, `/permissions`, `/add-dir`, `/memory`, `/init`, `/review`, `/security-review`, `/resume`, `/rewind`, `/export`, `/copy`, `/config`, `/rename`, `/branch` (`/fork`), `/cd`, `/diff`, `/btw`, `/recap`, `/autocompact`, `/effort`, `/output-style`, `/agents`, `/skills`, `/hooks`, `/mcp`, `/tasks` (`/bashes`), `/reload-skills`, `/exit`; custom commands, skills and MCP prompts as commands |
| Partial | `/agents`, `/hooks`, `/skills` list what is installed; they are not interactive editors. `/diff` prints the diff; there is no side panel. `/review` and `/security-review` are prompts, not multi-agent workflows |
| Missing | `/keybindings`, `/theme`, `/statusline` (set `statusLine` in settings instead), `/terminal-setup`, `/sandbox`, `/insights`, `/release-notes`, `/goal`, `/focus`, `/background`, `/stop`, `/loop`, and the bundled skills (`/simplify`, `/verify`, `/debug`, `/batch`, `/run`…) |
| Not applicable | `/login`, `/logout`, `/upgrade`, `/usage-credits`, `/install-github-app`, `/desktop`, `/mobile`, `/chrome`, `/ide`, `/remote-control`, `/teleport`, `/schedule`, `/plugin`, `/voice`, `/artifacts`, `/feedback`… |

### Tools

| | |
| --- | --- |
| Matched | `Read` (text, images, notebooks, paging), `Edit`, `Write`, `NotebookEdit`, `Bash` (persistent working directory, background mode, timeouts), `Glob`, `Grep`, `WebFetch`, `WebSearch`, `TodoWrite`, `Agent`, `AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode`, `Skill`, MCP tools, MCP resource tools, `ToolSearch` |
| Partial | `Read` does not read PDFs. `WebSearch` uses DuckDuckGo or a SearXNG instance you run, not a hosted search. Background shells are followed with `BashOutput` and `KillShell` (Claude Code's older names) |
| Missing | The `Task*` tools (coco keeps `TodoWrite`), `LSP`, `Monitor`, `PowerShell`, `EnterWorktree` / `ExitWorktree` |
| Not applicable | `Artifact`, `Cron*`, `RemoteTrigger`, `PushNotification`, `SendMessage`, `Workflow`, `SendUserFile`… |

### Permissions

| | |
| --- | --- |
| Matched | Modes `default` (`manual`), `acceptEdits`, `plan`, `dontAsk`, `bypassPermissions`; shift+tab cycle; rules as `Tool` or `Tool(specifier)` with deny over ask over allow; Bash prefix and glob rules, compound commands split and checked part by part, wrapper commands (`timeout`, `nice`, `nohup`, `xargs`…) stripped before matching; a built-in set of read-only commands that run without asking; path rules in gitignore syntax with `//abs`, `~/`, `/project` and relative forms; `Edit` rules covering all editing tools and `Read` rules covering search; `WebFetch(domain:…)`; `Agent(type)` and `Skill(name)` rules; MCP rules by server or tool; additional working directories; protected paths that always ask; the workspace trust question; "don't ask again" writing a rule |
| Missing | The `auto` mode (a classifier model that decides), operating-system sandboxing of shell commands, `Tool(param:value)` rules, managed (enterprise) policy settings |

Without a sandbox, permission rules are a guard against accidents, not a security boundary: a command the rules allow can still do anything your user account can.

### Hooks

| | |
| --- | --- |
| Matched | Events `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PostToolUseFailure`, `UserPromptSubmit`, `Stop`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`, `SessionStart`, `SessionEnd`, `Notification`; handler types `command`, `http` and `prompt`; the `if` condition; matchers (exact names or regular expressions); exit code 2 to block; JSON output (`continue`, `stopReason`, `systemMessage`, `decision`, `permissionDecision`, `updatedInput`, `additionalContext`, the `PermissionRequest` decision); `PreCompact` output as summary instructions; timeouts and the output cap; `disableAllHooks` |
| Missing | The other 20 events (`Setup`, `UserPromptExpansion`, `PermissionDenied`, `PostToolBatch`, `StopFailure`, `InstructionsLoaded`, `ConfigChange`, `CwdChanged`, `FileChanged`, `PreModelSwitch`, `PostModelSwitch`, the task, teammate, worktree and elicitation events…); handler types `mcp_tool` and `agent`; `async` hooks; hooks declared in skill or agent front matter |

### Skills and custom commands

| | |
| --- | --- |
| Matched | `SKILL.md` and command files with front matter `description`, `when_to_use`, `argument-hint`, `arguments`, `allowed-tools`, `disable-model-invocation`, `user-invocable`, `context: fork`, `agent`, `model`; `$ARGUMENTS`, positional and named arguments; `${CLAUDE_SKILL_DIR}`, `${CLAUDE_SESSION_ID}`, `${CLAUDE_PROJECT_DIR}`; inline and fenced `!` commands checked against `allowed-tools`; a listing in the system prompt sized to the context window; skills surviving compaction; user, project and `.claude` locations; namespaced commands |
| Partial | `model` and `effort` on a skill are parsed but do not switch the model for the turn. `paths` (load a skill only for matching files) is parsed and not applied |
| Missing | Skill-scoped hooks, plugin-provided skills, live reload when a skill file changes (use `/reload-skills`) |

### Subagents

| | |
| --- | --- |
| Matched | Agent files with `name`, `description`, `tools`, `disallowedTools`, `model`, `maxTurns`, `skills`, `omitClaudeMd`; built-in `general-purpose`, `explore` and `plan`; case-insensitive names; `--agents` and `--agent`; own context, final report returned; several read-only subagents in parallel; `SubagentStart` and `SubagentStop` hooks; `Agent(type)` permission rules |
| Missing | Nested subagents (Claude Code allows three levels; coco allows one, on purpose: a local server usually runs one request at a time and small models delegate too eagerly), background subagents, resuming a subagent, per-agent `permissionMode`, `mcpServers`, `hooks`, `memory` and `isolation: worktree`, agent teams |

### Memory

| | |
| --- | --- |
| Matched | User, project and local instruction files; files in parent directories; `@path` imports five levels deep; `.claude/rules/` with `paths` front matter; subdirectory instruction files loaded when the model first works there; `claudeMdExcludes`; auto memory (`MEMORY.md`, first 200 lines or 25 KB, per repository, readable and writable without prompts); `/memory`, `/init`, the `#` shortcut; instructions restored after compaction |
| Missing | Managed (organization-wide) instruction files, the `InstructionsLoaded` hook |

### MCP

| | |
| --- | --- |
| Matched | stdio, streamable HTTP and SSE servers; user, project (`.mcp.json`) and flag scopes; `${VAR}` expansion; tools, prompts (as slash commands) and resources; paginated listings; tool-list change notifications; output limits; reconnection after a crash; enabling and disabling a server in `/mcp`; tool search, which keeps rarely used tool definitions out of the prompt until they are needed; project servers held back until the workspace is trusted |
| Missing | OAuth sign-in for remote servers (static headers work), elicitation, sampling, `@server:resource` mentions in the prompt, serving coco itself as an MCP server |

### Interactive terminal

| | |
| --- | --- |
| Matched | Streaming Markdown with syntax highlighting; diffs in permission prompts; `@` file completion; `/` command completion; `!` shell mode; multi-line input (`\` + enter, alt+enter, ctrl+j, shift+enter where the terminal reports it, pasted text); message queueing while the model works; esc to interrupt and esc esc to rewind; shift+tab mode cycle; prompt history and reverse search; external editor; emacs-style line editing with kill, yank and undo; stashing a draft; background shells; task list; status line command; output styles; terminal bell |
| Missing | Vim mode, custom key bindings, themes, pasting images from the clipboard, the full-screen transcript viewer, prompt suggestions, voice input, mouse support |

### Sessions and headless mode

| | |
| --- | --- |
| Matched | Transcripts per project; `--continue`, `--resume` by id or name, `--fork-session`, `/branch`, `/rename`; file checkpoints with `/rewind` for code, conversation or both; cleanup of old sessions; `text`, `json` and `stream-json` output with `init`, `assistant`, `user`, `result`, `api_retry` and partial-message events; `stream-json` input; structured output with `--json-schema`; `permission_denials` in the result |
| Missing | The Agent SDK (a library interface) and its control protocol, background sessions, worktree sessions |

## Out of scope

These belong to Anthropic's hosted products and are not planned: accounts and billing, cloud and web sessions, the desktop and mobile apps, IDE extensions, the Chrome extension, Slack and GitHub apps, remote control, the plugin marketplace, agent teams, scheduled tasks and routines, artifacts, voice, telemetry, managed enterprise settings, Bedrock and Vertex setup.

## Deliberate differences

- **TodoWrite, not the Task tools.** One tool with one list is easier for a small model to use correctly than four tools.
- **One level of subagents.** See above.
- **Tool definitions are trimmed to the situation.** Plan-mode, notebook and skill tools are left out when they cannot apply, and MCP tools are deferred behind tool search, because every definition costs context on every request and local context windows are small.
- **Limits scale with the context window.** Tool output, the skill listing and what is restored after compaction all shrink on small windows.
- **Requests time out on silence, not on total duration.** A local model can take minutes to load or to produce a long answer.
