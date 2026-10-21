# runanything

[![CI](https://github.com/itIsMaku/runa/actions/workflows/ci.yml/badge.svg)](https://github.com/itIsMaku/runa/actions/workflows/ci.yml)

One command to discover and run a project's tasks. Both `runa` and `runany` work.

```sh
cd my-project
runa                        # Detect and run the default task
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

Install [cloudflared](https://developers.cloudflare.com/tunnel/downloads/) once (on macOS: `brew install cloudflared`). Then, in a web project:

```sh
runa --publish
```

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
