# Agent instructions

## Commit messages

Use [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/) for all new commits in this repository.
- Format: `type(scope): description`. The scope is optional; add `!` immediately before `:` for a breaking change.
- Use `feat` for new features and `fix` for bug fixes. Other suitable types include `docs`, `refactor`, `test`, `build`, `ci`, `style`, `perf`, and `chore`.
- Write concise English descriptions and lowercase types. Choose a scope that identifies the affected area when useful.
- Mark breaking changes with `!` or a `BREAKING CHANGE: description` footer. Separate optional bodies and footers with blank lines.
- Apply the same convention to PR titles and squash merge commit messages so merged history follows the convention.

Examples:

```text
feat(publish): offer installation of missing tunnel tools
fix(publish): handle interruption during installation prompts
docs: document conventional commit requirements
```


## Running project tasks

Use `runa agent` for managed development servers and background tasks so the user can observe and control them in the runa TUI. Use `node /absolute/path/to/runa/dist/bin.js agent` while developing an uninstalled version; rebuild after source changes.
- Discover tasks with `runa agent discover -C /absolute/project/path`; choose an explicit task ID when discovery is ambiguous.
- Check `runa agent list` before starting a server to avoid duplicates. Start with `runa agent start TASK_ID -C /absolute/project/path` and retain `result.id`. Add `--wait-ready` for HTTP servers; use it only when the app prints a loopback URL. For a known port, use `runa agent wait ID --for ready --port PORT --timeout 30000`.
- Read status with `runa agent inspect ID`. Read bounded logs with `runa agent logs ID --tail 100`; resume with `--after result.nextCursor`, fetching additional pages while `hasMore` is true. Use `logs ID --follow --timeout 5000` for a bounded NDJSON stream.
- Stop or restart the same process using its ID. Do not stop unrelated processes or use `runa agent shutdown` unless the user requested a global shutdown. Closing the TUI, an agent command timeout, or interrupting the client leaves managed apps running.
- Use `runa agent publish ID` only when the user asks to share that app publicly. `unpublish ID` removes the tunnel and keeps the app running. Missing tunnel dependencies return an error without installation prompts; report the installation instructions or let the user install through the TUI.
- Responses are JSON `{version, ok, result}` or `{version, ok, error: {code, message, details?}}`. Exit 124 means timeout and 130 interruption; a readiness timeout includes the process ID in `error.details.process.id`. Reconcile uncertain starts with `list`. Use `runa agent capabilities` for available operations.
- Direct commands such as `runa dev` run in the foreground and are not tracked in the dashboard. Use normal foreground invocations for short build/test checks or tasks requiring interactive stdin.
- Isolate manager integration tests with a temporary `RUNA_STATE_DIR` and stop that test manager during cleanup. Never use the user's real manager or public Internet tunnels in automated tests.
