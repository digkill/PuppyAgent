<p align="center">
  <img src="assets/Puppy%20Agent%20Tech%20Mascot%20Logo.png" alt="Puppy Agent mascot: a friendly puppy with glasses and a coding laptop" width="300" />
</p>

# 🐶 Puppy Agent

**English** · [Русский](README.ru.md)

Your loyal AI coding companion. A TypeScript / Node.js terminal agent that uses API models, works with files and commands, remembers sessions, and delegates tasks to helper puppies.

This is the first working CLI core. It has **no runtime package dependencies**: native `fetch`, `node:sqlite`, and Node's TypeScript support. Requires **Node.js 22.15+**. On Node 22, SQLite and TypeScript support may print experimental warnings.

## Quick start

No package installation is needed to run:

```bash
npm start -- init --tmp /absolute/path/to/puppy-temp
npm start -- config
```

Open the printed config file. See [puppy.config.example.json](puppy.config.example.json) for provider examples. Configure your provider and model, then add its key to `.env` in the Puppy Agent root (see [.env.example](.env.example)):

```dotenv
KIE_API_KEY=your-key
```

Then launch:

```bash
npm start -- models
# Put the exact returned model ID into providers.kie.model in config.json.
npm start -- chat
```

The config stores the **environment-variable name**, not your key. Puppy automatically loads its own root `.env` before reading config or connecting to providers. Existing shell environment values take priority, so `export KIE_API_KEY=...` still works. The working repository's `.env` is not loaded when using `--cwd` or restoring a session. `.env` is excluded from version control. Set `PUPPY_CONFIG=/absolute/path/config.json` in the environment or Puppy's `.env` to use a different config location.

The default engine is **Claude Opus 5.5 via Kie**, model `claude-opus-5-5`, endpoint `https://api.kie.ai/claude/v1/messages`, with Bearer authentication and streaming. `modelsUrl` separately points to `https://api.kie.ai/anthropic/v1/models` for live model discovery. Actual access depends on your account. No live paid-provider request has been verified as part of this bootstrap. See [Kie's model documentation](https://docs.kie.ai/market/claude/claude-opus-5-5).

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

`stream: true` enables Anthropic SSE, including fragmented `tool_use` JSON. Tools execute only after a complete `message_stop`; a truncated/error stream saves available usage evidence and never executes partial tools. Set `stream: false` for a buffered response. OpenAI Chat responses are currently buffered.

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

The launch folder is removed on normal exit, while the SQL database is retained. After a hard kill, leftover launch folders may be removed manually. Put final deliverables outside the disposable directory.

## Development

```bash
npm install
npm run typecheck
PUPPY_TEST_TMP=/absolute/test/temp npm test
```

Only static checks need TypeScript and `@types/node`. Tests use `node:test`, explicit temporary locations, and mocked provider transport. No API credentials or paid calls are needed. Fixtures clean up their own folders.

Current boundaries: OpenAI Chat responses are buffered. GUI, MCP, browser tools, automatic process recovery after app exit, isolated helper worktrees, and provider-enforced hard monetary ceilings are not implemented. This is a functioning foundation to extend, rather than a feature-complete replacement for a mature coding-agent product.
