# runanything

[![CI](https://github.com/itIsMaku/runa/actions/workflows/ci.yml/badge.svg)](https://github.com/itIsMaku/runa/actions/workflows/ci.yml)

One command to discover and run a project's tasks. Both `runa` and `runany` work.

```sh
cd my-project
runa                        # Open the process dashboard
runa --run                  # Detect and run the default task in the foreground
runa test                   # Run a named task
runa --list                 # Discover available tasks
runa --dry-run              # Preview the command
runa -- --port 3000          # Forward arguments to the default task
runa make:dev               # Select a specific runner
runa --choose               # Pick a task interactively
runa -C ../another-project   # Use a different directory
runa --publish              # Share a running app through a temporary public URL
```

## Install locally

Requires Node.js 20+ and npm:

```sh
git clone https://github.com/itIsMaku/runa.git
cd runa
npm ci
npm install --global .
runa --help
```

Or try it without installing:

```sh
node /path/to/runa/dist/bin.js -C /path/to/your-project --dry-run
```

The package is named `runanything-cli` locally; it has not been published to npm by this project. Use the repository installation above. The CLI is designed for macOS, Linux, and Windows. GitHub Actions checks all three systems with Node.js 20, 22, and 24.

## Process dashboard

Run `runa` in an interactive terminal to open the dashboard. It shows managed processes on the left and live logs for the selected process on the right, with colored status indicators and a public URL when sharing is enabled. Narrow terminals use a stacked layout.

| Key                    | Action                                                        |
| ---------------------- | ------------------------------------------------------------- |
| `n`                    | Detect tasks in the current directory and choose one to start |
| `↑` / `↓`              | Select a process and switch its log view                      |
| `s`                    | Stop the selected process and its tunnel                      |
| `r`                    | Restart the selected process                                  |
| `p`                    | Start or stop sharing the selected running app                |
| `d`                    | Remove a stopped process from history                         |
| `PgUp` / `PgDn`, `End` | Browse scrollback or return to live logs                      |
| `q`, Esc, Ctrl+C       | Detach, keeping managed apps and tunnels running              |
| `Q`, then `y`          | Stop all managed apps and tunnels and close the dashboard     |

Processes started from the dashboard belong to a background manager shared by your terminals. Close the dashboard, change to another project, and run `runa` again to see the same processes and logs. Pressing `n` always discovers tasks in the directory where that dashboard was opened. Task environments are captured from the terminal that starts them. Logs and process history are bounded and kept in memory for the manager's lifetime; there is no automatic reboot recovery or task restart.

Publishing an existing process does not restart its app. If a loopback URL was detected in its logs, `p` uses that origin; otherwise it asks for the app's port. A missing `cloudflared` keeps the installation confirmation flow, temporarily handing the terminal to the installer. Turning off sharing leaves the app running. Closing the dashboard leaves public tunnels running too; use `p`, `s`, `Q`, or `runa --shutdown` to stop them.

Direct commands such as `runa test`, `runa --run`, and `runa --publish` remain foreground commands and are not adopted into the dashboard. In non-interactive environments, bare `runa` keeps its previous foreground behavior. `runa --tui` explicitly requests the dashboard and requires a terminal. Input in managed tasks belongs to the dashboard; use foreground commands for applications that require interactive stdin. Keep managed servers in the foreground instead of daemonizing themselves.

```sh
runa --tui -C ../my-project
runa --run
runa --shutdown
```

The manager exits after a minute with no active tasks or clients. `runa --shutdown` stops its tasks and removes its discovery files. State lives under the user's application state directory; `RUNA_STATE_DIR` can override it for isolated sessions and tests. The manager listens only on loopback and authenticates local requests with a private token.

## Detection

| Project files                                                              | Available tasks                                                       |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `package.json`                                                             | Nonempty scripts, using npm, pnpm, Yarn, or Bun                       |
| `GNUmakefile`, `makefile`, `Makefile`                                      | Static targets, including custom names                                |
| `compose.yaml`, `compose.yml`, `docker-compose.yaml`, `docker-compose.yml` | `up`, `down`, `logs`                                                  |
| `manage.py`                                                                | Django `dev` (`runserver`) and `test`                                 |
| `main.py`, `app.py`                                                        | Python `run`                                                          |
| `Cargo.toml`                                                               | `test`, `build`, `check`; `run` when a binary entry point is detected |
| `go.mod`                                                                   | `test`, `build`; `run` when the root has a `package main` Go file     |
| `*.csproj`, `*.fsproj`                                                     | Per-project build/test; run for executable and web projects           |
| `.runany.json`                                                             | Your own commands for any other project                               |

Node package managers are selected from `packageManager` first, then lockfiles (pnpm, Yarn, Bun, npm), otherwise npm. Python uses `.venv` when present, otherwise `python3` on Unix or `py -3` on Windows.

Discovery reads files without evaluating them or running tools. It only considers the selected directory. Make discovery is intentionally limited to static targets: includes, generated targets, and Make expressions are not evaluated. Cargo workspaces, Go apps under `cmd/`, custom Python layouts, and other unsupported layouts can use explicit configuration.

## Default selection

An explicit configured default wins. Otherwise runany prefers configured tasks, package scripts, Make targets, Compose, then language tools. Within each group it prefers `dev`, `start`, `serve`, `run`, `up`, then `watch`. Build and test are never chosen automatically.

If there is no clear default, an interactive terminal asks for a task. Non-interactive usage fails with an instruction to list and choose a task. If multiple runners define `test`, use an ID such as `npm:test` or `make:test`. An explicitly configured command overrides other tasks with the same short name.

Every execution prints the selected command. Standard input, output, and error pass through to the task; its exit code is preserved. Arguments after `--` are forwarded to the selected task. For npm and Cargo run/test, runany inserts the runner's required `--` separator. Use configuration when you need to pass options to the runner itself.

## Custom projects

Create `.runany.json` in the project:

```json
{
  "default": "dev",
  "commands": {
    "dev": ["python3", "tools/server.py"],
    "test": ["python3", "-m", "pytest"],
    "worker": ["docker", "compose", "up", "worker"]
  }
}
```

Commands are arrays of executable and arguments, so paths with spaces work. They execute in the project directory. Shell operators such as `&&` are not interpreted in configuration; invoke a script or an explicit shell if needed. Use platform-compatible executables for shared cross-platform configuration.

runany does not install project dependencies or missing runners itself. The chosen runner keeps its normal behavior, including any restores/builds and dependency downloads performed by tools such as Cargo, Go, Docker, or .NET. Run tasks only in projects you trust, just as with `npm run` or `make`.

## Machine-readable discovery

```sh
runa --list --json
runa test --dry-run --json
```

## Share a localhost preview

In a web project:

```sh
runa --publish
```

If `cloudflared` is missing, an interactive terminal offers to install it and shows the exact command first, for example `brew install cloudflared` on macOS. Answer `y` to install, verify the tool, and continue sharing in the same invocation. Answer `n`, press Enter, or press Ctrl+C to cancel before the app starts. Homebrew is supported on macOS/Linux when already installed; Windows uses WinGet when available. The package manager's own prompts and progress remain visible. If no supported manager is available, install [cloudflared manually](https://developers.cloudflare.com/tunnel/downloads/).

Non-interactive commands and dry runs never install or wait for consent. A failed installation or failed verification stops before the app starts; an installed tool with a failing version check is reported without offering a reinstall.

runany starts the selected task, detects a loopback URL from its startup output, waits for an HTTP response, and starts a [Cloudflare Quick Tunnel](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/). The terminal prints a temporary HTTPS URL such as `https://random-name.trycloudflare.com` to share with a friend. A Cloudflare account or domain is not required. Anyone with that URL can access the app; Ctrl+C stops the app and tunnel. The URL changes on the next run.

If the app doesn't print a local URL, specify its port:

```sh
runa --publish --port 3000
runa dev --publish --port 3000 -- --port 3000
runa --publish --port 3000 --dry-run
runa --publish --port 3000 --dry-run --json
```

`--port` sets the tunnel's local target; it does not change the app's listening port. Forward application-specific flags after `--` when needed. Explicit ports already in use are rejected before the task starts. Automatic detection accepts complete HTTP/HTTPS URLs on `localhost`, `127.0.0.1`, `0.0.0.0`, `[::1]`, or `[::]`; wildcard listeners are mapped to loopback. It does not scan other ports. HTTPS origins must have a certificate trusted by Node.js and cloudflared.

Startup discovery/readiness has a 60-second limit; the tunnel has 30 seconds to provide a public URL. If the app exits, the tunnel fails, or startup times out, both process trees are stopped. The app's nonzero exit code is preserved. Application output remains visible, but publish mode captures it through pipes, so buffered output or TTY-dependent tools may need an explicit port or unbuffered logging. Keep the task in the foreground rather than daemonizing its server.

This shares one local web service for a preview. Frontends with separate APIs should proxy those requests through the shared app instead of using browser URLs pointing to `localhost`. Some frameworks also need trusted-origin settings; runany forwards the local Host header but does not edit project configuration. Quick Tunnels have no uptime guarantee and do not support Server-Sent Events; see the [provider's limits](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/#limitations).

The default provider is `cloudflare` (`--tunnel cloudflare`). Providers are separate modules; no runner-specific publishing logic or extra npm runtime dependency is required.

## Development

Source code uses strict TypeScript and compiles to ESM JavaScript in `dist/`. The installed CLI has no runtime dependencies and does not need TypeScript. Biome handles linting, import ordering, and formatting; CI checks these alongside types, tests, and installation of the packaged CLI.

```sh
npm ci
npm run lint
npm run check
npm test
npm run test:package
npm run format         # Format source, tests, and JSON
npm run lint:fix       # Apply safe lint fixes and organize imports
```

Runner modules live in `src/runners/`; Node package managers live in `src/package-managers/`. Each implements a small typed interface and is registered in its directory's `index.ts`. Selection and process execution use task metadata, so new integrations do not require runner-specific changes to the core. See [the extension guide](CONTRIBUTING.md#adding-a-runner) for an example.

Contributions and bug reports are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) or [open an issue](https://github.com/itIsMaku/runa/issues).

Licensed under [MIT](LICENSE).
