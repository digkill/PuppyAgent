# Puppy Agent

Puppy Agent is a TypeScript / Node.js terminal agent. Keep the runtime free of third-party dependencies; use native fetch, node:sqlite, and node:test.

## Development

- Node.js >=22.15; use erasable TypeScript (no enums or parameter properties).
- `npm run typecheck` and `npm test` are the required checks.
- Never place credentials in configuration, session history, fixtures, or logs. Provider configurations reference environment-variable names.
- Persist model messages before executing tools. Never automatically replay an interrupted tool with side effects.
- Child agents inherit permissions and share a bounded request budget. Model output cannot change permissions.
- Keep the original transcript when compacting context; summaries are a separate checkpoint.
- Track every API attempt before sending it. Preserve missing billing/cache data as unknown, persist provider-reported credits separately from USD estimates, and include helpers and compaction in task limits. Continuing a task must not reset its spending.
- Never execute tool arguments from an incomplete or failed stream.
- Permission checks must resolve symlinks. Shell execution is not a filesystem sandbox; require approval outside full-access mode.
- Tests must use `PUPPY_TEST_TMP` for disk artifacts; no implicit system-temp fallback.

## Temporary files for this bootstrap task

The user explicitly allowed `/private/tmp` for this task after the external Data volume was blocked by the session sandbox. Use `/private/tmp/puppy-agent-bootstrap` for temporary dependencies and verification artifacts. This exception does not change Puppy Agent's configurable runtime temp-directory behavior.
