<p align="center">
  <img src="assets/Puppy%20Agent%20Tech%20Mascot%20Logo.png" alt="Puppy Agent mascot: a friendly puppy with glasses and a coding laptop" width="300" />
</p>

# 🐶 Puppy Agent

**English** · [Русский](README.ru.md)

Your loyal AI coding companion. A TypeScript / Node.js terminal agent that uses API models, works with files and commands, remembers sessions, and delegates tasks to helper puppies.

Created by [MediaRise](https://MediaRise.org).

## Global installation and updates

From this checkout, with your `.env` configured:

```bash
npm run install:global
# Or choose a user-owned npm prefix:
npm run install:global -- --prefix "$HOME/.local"
```

If npm's default command directory is not writable, the installer automatically uses `~/.local`. Ensure the printed command directory is in `PATH`. Then use the agent from any directory:

```bash
cd /path/to/any/project
puppy
puppy --version
puppy update --check
puppy update
```

`puppy-agent` is an alias for `puppy`. The installer builds plain JavaScript with Node's built-in TypeScript stripper, packs a local archive, and installs it globally without runtime dependencies or lifecycle scripts. Private `.env` files are excluded from the archive. Your source `.env` is copied to `~/.config/puppy-agent/.env` only when that file does not exist; config, keys and SQLite sessions stay outside the package and survive updates. An existing config is preserved; a missing config is initialized.

`puppy update` checks the default branch of this project's recorded HTTPS Git repository and installs a higher package version. It never substitutes an unrelated package from the public npm registry or downgrades the installed version. Source changes must be pushed with a higher `package.json` version before remote updates can find them. `puppy update --local` reinstalls the recorded local checkout, including unpublished changes at the same version. `--source /path/to/checkout` chooses another local source explicitly. Git and npm are needed for installation/updates; Node.js 22.15+ runs the installed CLI. Update checks happen only when requested.

This is the first working CLI core. It has **no runtime package dependencies**: native `fetch`, `node:sqlite`, and Node's TypeScript support. Requires **Node.js 22.15+**. On Node 22, SQLite and TypeScript support may print experimental warnings.

## Quick start

No package installation is needed to run:

```bash
# First set PUPPY_TMP_DIR in Puppy's root .env (see .env.example).
npm start -- init
npm start -- config
```

Open the printed config file. See [puppy.config.example.json](puppy.config.example.json) for provider examples. Configure your provider and model, then add its key to `.env` in the Puppy Agent root (see [.env.example](.env.example)):

```dotenv
ARGO_LINK_API_KEY=your-key
PUPPY_TMP_DIR=/Volumes/Data/CodexTemp/puppy-agent
PUPPY_MODEL=claude-opus-5-5
PUPPY_FALLBACK_MODEL=claude-sonnet-5-5
PUPPY_EFFORT=medium
```

Then launch:

```bash
npm start -- models
# Put the exact returned model ID into providers.kie.model in config.json.
npm start -- chat
```

The config stores the **environment-variable name**, not your key. Puppy loads its own checkout `.env` and then the user-level `~/.config/puppy-agent/.env` before reading config. Existing environment values win; the checkout's entries take priority over user-level fallback entries. Global installs also load the original checkout `.env` recorded by the installer while that checkout exists; the user-level file remains a fallback. Set `PUPPY_ENV_FILE=/absolute/path/.env` to load only that file. The working repository's `.env` is never automatically loaded. Set `PUPPY_CONFIG=/absolute/path/config.json` to select a different config file.

## Model and effort

`PUPPY_MODEL` and `PUPPY_EFFORT` select defaults for new sessions. Saved sessions restore their own choices. Explicit launch flags `--model MODEL_ID --effort high` override a restored session. The current selections appear in `/status` and are recorded with requests for cost comparisons.

```text
/model                  # Fetch live models and choose a number
/model claude-opus-5-5   # Select a model from that provider's live list
/effort                 # Choose an effort level interactively
/effort high
/effort auto
```

Switching a model within one provider preserves conversation history. Helpers inherit both model and effort. Token price estimates configured for another model are not reused after switching.

Levels: `auto`, `low`, `medium`, `high`, `xhigh`, `max`. `auto` omits the field; other levels send Anthropic `output_config.effort` or OpenAI Chat `reasoning_effort`. Supported levels depend on the model. These are requested settings, not measured reasoning capacity. Kie's published schema currently documents `thinkingFlag`, not granular effort, so its enforcement of the Anthropic effort field is **unverified**. Puppy does not silently map several levels to the same boolean or retry a paid request without the parameter. Use `auto` if your provider rejects effort. [Anthropic effort documentation](https://platform.claude.com/docs/en/build-with-claude/effort).

The default engine is **Claude Opus 5.5 via ArgoLink**, model `claude-opus-5-5`, native endpoint `https://argolink.io/v1/messages`. Kie remains available as `/provider kie`. See [ArgoLink documentation](https://argolink.io/en/docs).

## English and Russian

English is the default for the CLI and model responses. Select Russian during setup, at launch, or inside the chat:

```bash
npm start -- init --tmp /absolute/temp/path --language ru
npm start -- chat --language ru
```

```text
/language ru
/language en
```

Set `"language": "ru"` in config for new sessions. The launch flag and chat command save the language in the selected session. Resuming restores that language; helper puppies inherit it. Tool output and technical error messages may remain in English. Explicit user requests can override the model's default response language.

The interactive greeting uses the user's terminal mascot from [puppy_agent.py](puppy_agent.py), ported to [TypeScript](src/mascot.ts). Python is not required. The TrueColor puppy has a compact fallback for narrow terminals and `NO_COLOR`. Use `--no-banner` to disable it; noninteractive runs do not print the mascot. The original PNG in `assets/` is the project's brand asset.

## Sessions and commands

Responses in a terminal render Markdown: headings, emphasis, inline code, lists and checkboxes, quotes, visible links, rules, and tables. Language-tagged fenced code blocks get built-in lexical syntax colors for JavaScript/TypeScript, Python, Go, JSON/JSONC, Bash, SQL, YAML, PHP, HTML/XML, CSS, diff, C/C++, Rust, Java and C#. Unknown languages remain readable plain code. Source code characters and indentation are preserved; HTML is shown as text rather than executed.

Streaming formatting waits for complete lines and complete table rows/blocks. Helper replies and billing notices are kept out of an active response's code blocks. The SQLite transcript retains the original model text; formatting changes only its display.

```bash
puppy --no-color        # Plain formatting, no ANSI colors (also respects NO_COLOR)
puppy --no-markdown     # Show original Markdown markup
puppy run 'task' --color # Force rich output, including when redirected
```

When stdout is redirected, responses keep raw Markdown without ANSI by default. Explicit `--color` overrides `NO_COLOR`; `--no-color` wins if both flags are set. Terminal escape sequences supplied by the model are removed; styling comes only from the renderer. This is a practical Markdown subset, not a browser or a complete CommonMark implementation.

```bash
npm start -- chat --new --cwd /path/to/project --permission workspace-write
npm start -- run 'Inspect this project and explain its architecture' --permission read-only
npm start -- resume --last
npm start -- resume --here
npm start -- resume SESSION_ID
npm start -- sessions
```

`chat` restores the latest root session for the current directory. `--new` starts fresh. `resume --last` restores the latest root session across directories, including its saved working directory, provider, model, language, and permissions. `resume --here` selects the current directory's last session. If a saved directory is missing, Puppy fails clearly instead of silently switching directories. `--permission` explicitly overrides the selected session's mode. Start a new session to switch provider.

| Chat command | Action |
| --- | --- |
| `/sessions`, `/resume ID` | List and restore sessions |
| `/new` | Start a session in the current directory |
| `/cd PATH` | Restore or create a session for another directory |
| `/status` | Show session, directory, provider, mode, usage, and temp path |
| `/permissions MODE` | Change this session's permission mode |
| `/language en`, `/language ru` | Select interface and response language |
| `/model [MODEL_ID]`, `/effort [LEVEL]` | Choose model or requested effort, retaining context |
| `/memory` | Show global, project, and session memory |
| `/remember KEY VALUE` | Save a project fact |
| `/forget KEY` | Remove a project fact |
| `/compact` | Summarize older complete turns, retaining the full transcript |
| `/continue` | Continue the saved task |
| `/usage`, `/usage json` | Pack-wide token, cache, credit and request records |
| `/exit` | Exit |

During execution, `Ctrl+C` cancels requests and shell commands throughout the pack. At the input prompt, it exits. Mid-task chat input is not implemented yet.

## Providers

Add named providers in `providers` and select one using `provider` or `--provider name`. Supported protocols:

- `anthropic`: Anthropic Messages with client tool calls.
- `openai-chat`: OpenAI-compatible Chat Completions with function calls.

`baseUrl` includes the API version; Puppy appends `/messages`, `/models`, or `/chat/completions`. Optional `modelsUrl` selects a separate discovery URL on the same origin. Authentication can be `bearer`, `x-api-key`, or `none`. HTTPS is required except for localhost. Redirects are refused to prevent forwarding credentials. The OpenAI adapter uses `max_completion_tokens`; the selected service must support that field. Responses API is not implemented.

`stream: true` enables Anthropic SSE, including fragmented `tool_use` JSON. Tools execute only after a complete `message_stop`; a truncated/error stream saves available usage evidence and never executes partial tools. Set `stream: false` for a buffered response. OpenAI Chat also supports streaming; tool calls execute only after a complete response.

## Usage, cache and spending limits

Every API attempt gets a SQL ledger entry **before sending**, including its task ID, session, provider, requested/actual model, response ID, timing, status, raw usage and price snapshot. Successful responses, failed/truncated streams and interrupted pending attempts remain distinguishable. Summarization calls count too.

Statistics separate uncached input, cache reads, cache creation, 5-minute/1-hour cache writes and output. Anthropic reports cache counters separately from `input_tokens`; OpenAI's cached prompt tokens are already included in `prompt_tokens`. Puppy normalizes these conventions without adding cached input twice. Missing fields remain `null`, and reports show coverage.

Kie's response field `credits_consumed` is stored as **provider-reported request billing**. No account-balance difference is attributed to an individual request. Missing credit data is unknown, not zero. Token-price estimates and credit-to-USD conversions are separate fields, using optional configured `pricing` rates saved with the request. Kie cache prices are intentionally not assumed. No fixed percentage saving is claimed.

If your provider's streaming response omits billing, a limited task stops; review that request in provider logs and select `stream: false` for a new task if buffered responses expose credits. Puppy will not replay the paid request automatically to obtain billing.

```bash
npm start -- usage --json
npm start -- usage SESSION_ID --run-id TASK_ID --json
```

The export includes the parent and all helper sessions. Use task IDs and matching repository/task conditions when comparing cost, latency and successful completion with Cursor. `summedRequestLatencyMs` is a sum of API durations, not wall-clock task duration; parallel calls overlap. Completion status is the agent's execution status, not an independent correctness grade.

The default Kie provider has `maxTaskCredits: 10`. Change it to a positive threshold for new tasks, or omit the field to disable the credit threshold. A task and all descendants share one persisted allowance. `/continue` restores an unfinished task's allowance and spending; it does not reset the budget. New user tasks receive a new allowance. `maxPackCalls` also retains consumed calls when continuing a task.

Once the threshold is reached, Puppy sends no further model requests and refuses pending tool actions from that response. Missing billing data also stops limited tasks before continuing. **This is a stop threshold, not a guaranteed hard spending ceiling:** a request, or several already in flight, can exceed the remaining allowance; the API does not provide an advance upper charge. Other applications and arbitrary shell commands are outside this ledger. An unfinished request after a crash leaves unknown billing and blocks continuation under a credit limit until reviewed; starting a new task is an explicit new allowance.

`promptCache` can be `off`, `5m`, or `1h` for Anthropic protocol. It emits the documented automatic `cache_control` request setting. Kie defaults to `off` until cache-control support and billing are verified for your account; returned backend cache statistics are still recorded. The direct Anthropic example enables 5-minute caching and contains a dated, editable official price snapshot. [Anthropic caching documentation](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

HTTP requests are not retried automatically, so ambiguous requests do not silently cause repeated charges. Error response bodies are not printed or persisted. Provider keys are read from the environment when making requests and removed from shell-tool environments.

## Permissions

| Mode | Read workspace/tmp | Write workspace/tmp | Outside workspace | Shell | Tool memory writes |
| --- | --- | --- | --- | --- | --- |
| `read-only` | Yes | Denied | Denied | Denied | Denied |
| `ask` | Yes | Confirm | Confirm | Confirm | Confirm |
| `workspace-write` | Yes | Yes | Confirm | Confirm | Confirm |
| `full-access` | Yes | Yes | Yes | Yes | Yes |

Approvals apply to one action. Noninteractive `run` denies actions requiring confirmation. Selecting `full-access` in config, CLI, or `/permissions` explicitly enables execution without confirmation under your OS account. Model output cannot change modes. Children inherit their parent's mode and workspace.

These are **application tool checks, not an OS sandbox**. File paths resolve symlinks before approval. An approved shell command has the process's ordinary filesystem and network access. Use an external container or separate OS account for isolation. Concurrent path replacement by another process is not prevented at OS level. Shell tools inherit environment variables other than the configured provider keys.

## Context, instructions, and memory

SQLite stores the full transcript, tool requests/results, working directory, agent hierarchy, permissions, language, token usage, and events. `dataDir` holds persistent state separately from temporary work.

Assistant messages are committed **before** tools run; every tool result is committed separately. On resume, unresolved tool calls receive an explicit "outcome unknown" result. Puppy does not automatically repeat an interrupted action.

Older complete turns can be summarized into a separate checkpoint. Original messages stay in SQL, and recent user turns remain intact. Within one long task, Puppy can summarize older tool rounds while retaining the exact original user request and the two latest complete assistant rounds. Tool calls are kept with their results. The budget uses a conservative byte estimate rather than an exact model tokenizer. Configure `contextBudgetTokens` below your model's actual context window. Input or recent evidence too large to fit fails clearly without silently discarding messages.

Instructions come from:

- `instructions` and explicitly configured `instructionFiles` (absolute paths or `~/...`).
- `AGENTS.md` and `.puppy/AGENTS.md` from the workspace root down to the current directory.
- Scoped instruction files discovered before file access in nested directories. Newly discovered rules are returned to the model before allowing the tool to retry. Shell commands must follow scoped instructions themselves.

Persistent memory has global, project, and session scopes. The model's `remember` tool can write project/session facts after permission checks. Global memory is read from storage; there is no model tool for writing it. Context reloads instructions and memory before each request. Children share project memory and have separate session memory.

Request events save system-prompt snapshots and message IDs for inspection. Avoid putting secrets in instructions, prompts, files sent to the model, or memory: these may appear in local history and are sent to the chosen API provider.

## The puppy pack

`spawn_puppy`, `wait_puppies`, and `list_puppies` coordinate helpers. Each puppy has a separate SQL session with a parent ID and persisted output. A child inherits its parent's model, provider, workspace, mode, language, summary, and a bounded snapshot of recent context. The complete parent transcript remains in SQL.

The parent can work while helpers run. `maxChildren` caps all helpers created per task run; `maxParallelChildren` caps simultaneous helpers; `maxDepth` caps nesting. `maxPackCalls` bounds API calls across the **entire pack**, including summarization. `maxSteps` bounds each agent. If the pack is full, further spawning fails until existing helpers finish. Parent turns wait for their helpers before returning.

The filesystem is shared. Delegate different files to different puppies; isolated worktrees and automatic merging are not implemented.

After restoring a parent session, `list_puppies` and `wait_puppies` can retrieve saved helper reports. Unleased helpers left in a running state are marked interrupted; they are not restarted automatically. A report from an interrupted helper may be partial.

## Temporary work

`tmpDir` is required. There is no silent system-temp fallback. Each launch creates `run-UUID` and sets `TMPDIR`, `TMP`, `TEMP`, npm cache, XDG cache, and Python bytecode paths to it. Missing `/Volumes/<name>` mounts fail explicitly. Programs ignoring environment variables require explicit output/cache arguments; arbitrary shell programs are not forcibly redirected without an OS sandbox.

Set `PUPPY_TMP_DIR` in Puppy's `.env` to use the same location for setup and subsequent launches without `--tmp`. Priority: explicit `--tmp` flag, then `PUPPY_TMP_DIR`, then `tmpDir` in config. Changes in `.env` take effect on the next launch, including restored sessions. Initialization stores the selected path in config.

The launch folder is removed on normal exit, while the SQL database is retained. After a hard kill, leftover launch folders may be removed manually. Put final deliverables outside the disposable directory.

## Development

```bash
npm install
npm run typecheck
PUPPY_TEST_TMP=/absolute/test/temp npm test
```

Only static checks need TypeScript and `@types/node`. Tests use `node:test`, explicit temporary locations, and mocked provider transport. No API credentials or paid calls are needed. Fixtures clean up their own folders.

Current boundaries: OpenAI Chat responses are buffered. GUI, MCP, browser tools, automatic process recovery after app exit, isolated helper worktrees, and provider-enforced hard monetary ceilings are not implemented. This is a functioning foundation to extend, rather than a feature-complete replacement for a mature coding-agent product.


### Models and runtime settings

Claude Opus is the default coding engine; ArgoLink's live model list also exposes `claude-fable-5-2`. Select it with `/model claude-fable-5-2`. Helper puppies inherit the parent's model, permissions and shared task budget. Spawn independent helpers before waiting to run them concurrently; `maxParallelChildren` defaults to 3.

```dotenv
PUPPY_PROVIDER=argolink
PUPPY_MODEL=claude-opus-5-5
PUPPY_FALLBACK_MODEL=claude-sonnet-5-5
PUPPY_EFFORT=auto
PUPPY_MEMORY=true
PUPPY_FUNCTION_CALLING=true
PUPPY_MAX_TOKENS=16384
PUPPY_STREAM=true
```

Memory controls whether earlier tasks enter the next request; SQL transcripts remain intact and current tool rounds are always retained. Function calling enables tools and helper puppies. Max tokens limits each model response. Use `puppy chat --new` after changing model defaults, or `/model` in a restored session: saved sessions retain their model.

Kie's `gemini-4-carbon-openai` has a separate OpenAI endpoint, selected automatically. Its documented route is chat-only, so Puppy disables tools/helpers for it. Claude uses the native Messages API, with adjacent user/tool-result messages merged for gateway compatibility.

For local Qwen/Llama, start Ollama or LM Studio with a tool-capable model, then set `PUPPY_PROVIDER=ollama` (or `lmstudio`), `PUPPY_MODEL=<installed model id>`, `PUPPY_EFFORT=auto`. `/provider ollama` creates a separate session and discovers installed models. Defaults are `http://127.0.0.1:11434/v1` and `http://127.0.0.1:1234/v1`; `PUPPY_BASE_URL` overrides the URL. Real local inference requires the local server to be running.

The backup model is **Claude Sonnet 5.5**. `/fallback` verifies availability and switches the current session while preserving history, permissions and task budget. Configure `PUPPY_FALLBACK_MODEL` in `.env` or `fallbackModel` in the provider profile. Failed paid requests are not automatically replayed; unknown billing still blocks `/continue`.

### ArgoLink

Set these in Puppy's own `.env`:

```dotenv
ARGO_LINK_API_KEY=
PUPPY_PROVIDER=argolink
PUPPY_MODEL=claude-opus-5-5
PUPPY_FALLBACK_MODEL=claude-sonnet-5-5
PUPPY_EFFORT=medium
```

The documented `ARGOLINK_API_KEY` name is also accepted; `ARGO_LINK_API_KEY` wins when both exist. Credentials stay out of config and SQL. Start `puppy chat --new` or use `/provider argolink`; old Kie sessions retain their saved provider. Select Fable 5.2 with `/model claude-fable-5-2`, or backup Sonnet with `/fallback`.

Claude uses native Messages with a five-minute system-block cache, streaming and tools. Puppy's `baseUrl` is `https://argolink.io/v1` because it appends `/messages`; the Anthropic SDK examples use the origin because that SDK appends `/v1/messages`. Other models route to Chat Completions; keep effort `auto` unless the specific model's support is verified.

ArgoLink bills USD, not Kie credits. `/usage` records separate token/cache usage and price estimates for Opus/Sonnet/Fable 5.2. Unknown fields remain unknown; estimates are not actual charges. The profile does not inherit `maxTaskCredits`. `maxPackCalls` bounds all helpers and compaction calls; set a monetary key quota in ArgoLink's console. Check actual charges in provider Usage. Account balance snapshot differences can include top-ups, holds and unrelated requests. Recognized `X-Client-Request-ID` values are preserved in request metrics for support.

### Response limits and continuation

`PUPPY_MAX_TOKENS=16384` caps each response, including Claude thinking. Summaries have an independent `PUPPY_COMPACTION_MAX_TOKENS=16384` ceiling and use low effort on verified routes. A summary that reaches its output limit gets one shorter regeneration; the original SQL transcript is retained. `PUPPY_CONTEXT_TOKENS=128000` is a conservative compaction threshold, not a promise of every model's context capacity.

After a complete API response ending in `max_tokens`/`length`, Puppy can continue up to `PUPPY_MAX_CONTINUATIONS=2` consecutive times. Partial tools are never executed; incomplete JSON is retained as separate diagnostic evidence. Failed connections, incomplete streams, content filtering and unknown billing under a monetary limit are not automatically replayed. Every attempt uses the same shared task budget. Set `0` to disable automatic continuation.

An ordinary message after an unfinished task retains that task's allowance. `/continue [instruction]` does so explicitly. Use `/new` for a separate new task/session. Restart the CLI after changing `.env` or updating; `puppy resume --last` restores the saved session and working directory.

### Permissions from .env

Set `PUPPY_PERMISSION_MODE=full-access` to run files, commands and memory operations without approval prompts. [.env.example](.env.example) lists all modes: `read-only`, `ask`, `workspace-write`, `full-access`. Precedence: `--permission` → environment/dotenv → saved session → config. An explicit environment setting also applies when restoring or switching sessions; otherwise saved permissions remain intact. Helpers inherit their parent's permissions. Restart after editing `.env`, or use `/permissions full-access` in the current process.

### Completing the whole goal

`PUPPY_GOAL_CHECK=true` enables a separate review of the original goal, current checkpoint and recorded tool results before completion. Remaining feasible work resumes the same task; an intermediate file list is insufficient. Genuinely missing input or external access pauses the task instead of marking it complete (batch exit code 2). The reviewer executes no tools. Review calls are paid and count toward the shared `maxPackCalls` budget.

`PUPPY_MAX_CONTINUATIONS=-1` follows the shared task budget without a separate token-limit interruption count. `0` disables it; `1`–`8` bound consecutive continuations. The full-task environment example sets `PUPPY_MAX_STEPS=80`. Spending/request limits are retained. Network failures and incomplete streams are not automatically replayed.

The CLI header now shows its loaded version and prints effective limits and goal-check state at launch. A running Node process retains old code after an update: exit with `/exit`, run `puppy resume --last`, then enter `/continue`.

`PUPPY_MAX_PACK_CALLS=160` in `.env` sets the task's shared API-call ceiling, including helpers, compaction and completion checks. Use a positive integer. Resuming subtracts prior attempts: 80 used with a ceiling of 160 leaves 80; spending is retained. Restart, restore the session and use `/continue` after changing it. `PUPPY_MAX_STEPS` independently bounds one agent's steps per run.

### API and stream timeouts

```dotenv
PUPPY_REQUEST_TIMEOUT_MS=900000
PUPPY_STREAM_IDLE_TIMEOUT_MS=180000
# Optional shell-command limit: PUPPY_COMMAND_TIMEOUT_MS=240000
```

The total request deadline is 15 minutes instead of 2. The separate stream idle limit is 3 minutes without incoming data; every chunk, including heartbeats, thinking and tool JSON, restarts that wait. Active generation past two minutes is allowed, while the total deadline still applies. Increase `PUPPY_REQUEST_TIMEOUT_MS` for longer generations. Values must be positive integer milliseconds, at most 2147483647; zero does not disable protection.

Ctrl+C interrupts a pending read immediately. `/usage json` distinguishes total-request and stream-idle timeouts through `metrics.failureKind`. Partial tools never execute; attempts and observed usage remain in SQL. Failed paid requests are not automatically replayed. `/continue` retains the task's spending. Restart after changing `.env` or updating.
