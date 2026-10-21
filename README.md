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
```

## Install locally

Requires Node.js 20+ and npm:

```sh
git clone https://github.com/itIsMaku/runa.git
cd runa
npm install --global .
runa --help
```

Or try it without installing:

```sh
node /path/to/anyrun/bin/runa.js -C /path/to/your-project --dry-run
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

## Development

No runtime dependencies or build step.

```sh
npm run check
npm test
npm pack --dry-run
```

Contributions and bug reports are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) or [open an issue](https://github.com/itIsMaku/runa/issues).

Licensed under [MIT](LICENSE).
