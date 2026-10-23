# Contributing

Thanks for helping improve runa. Report bugs and suggest features in [GitHub issues](https://github.com/itIsMaku/runa/issues). Include your operating system, Node.js version, the command you ran, expected behavior, and actual output. A minimal project file that reproduces a detection problem is especially helpful.

## Local development

Requires Node.js 20+ and npm. The source uses strict TypeScript; `npm run build` emits JavaScript and type declarations to `dist/`. There are no runtime dependencies.

```sh
git clone https://github.com/itIsMaku/runa.git
cd runa
npm ci
node dist/bin.js --help
npm run lint
npm run check
npm test
npm run test:package
```

Use `node dist/bin.js -C /path/to/project --dry-run` to try detection against another project without running its tasks. Rebuild after source changes. `npm test` builds automatically.

## Code style

Run `npm run format` to format code or `npm run lint:fix` to apply safe lint fixes and organize imports. Biome enforces two spaces, single quotes, braces around control-flow bodies, and a 100-character line width. `npm run lint` checks formatting, imports, and recommended lint rules without modifying files; warnings fail CI.

The repository includes EditorConfig settings and recommends the Biome VS Code extension, with formatting on save enabled. Generated `dist/`, dependencies, and the generated lockfile are excluded from formatting.

## Architecture

| Module                   | Responsibility                                                |
| ------------------------ | ------------------------------------------------------------- |
| `src/types.ts`           | Contracts for runners, package managers, tasks, and commands  |
| `src/context.ts`         | Read-only project files and cached reads                      |
| `src/runners/`           | Independent ecosystem detectors                               |
| `src/package-managers/`  | Node package manager lockfiles and script invocation          |
| `src/detect.ts`          | Invoke registered runners and combine their task descriptions |
| `src/selection.ts`       | Apply generic default and ambiguity rules                     |
| `src/process.ts`         | Forward arguments, spawn commands, and preserve exit codes    |
| `src/publish/`           | Readiness, temporary sharing, and tunnel providers            |
| `src/managed-process.ts` | Supervise and stop process trees while observing output       |
| `src/cli.ts`             | CLI parsing and presentation                                  |
| `src/daemon/`            | Shared supervision, bounded logs, and authenticated local RPC |
| `src/agent/`             | Versioned JSON commands, cursor logs, and bounded waits       |
| `src/tui/`               | Terminal rendering, key handling, and installation UX         |

Discovery only returns command data. Runner-specific argument separators, explicit defaults, name overrides, and startup preferences are metadata on tasks; the core does not branch on runner names or executables. The built-in registry is explicit, with no directory scanning or dynamic loading of project code.

## Adding a runner

Create `src/runners/maven.ts`, for example:

```ts
import type { Runner } from '../types.js';

export const mavenRunner: Runner = {
  id: 'maven',
  priority: 40,
  detect(context) {
    if (!context.has('pom.xml')) {
      return [];
    }
    return ['test', 'build'].map((name) => ({
      name,
      source: 'pom.xml',
      bin: 'mvn',
      args: [name === 'build' ? 'package' : 'test'],
    }));
  },
};
```

Import it and add it to `builtinRunners` in `src/runners/index.ts`. Add fixture tests and document the supported layouts. There are no changes to detection orchestration, selection, or process execution. This example is a starting point; built-in Maven support has not been added by this refactor.

Use `defaultRank` for a runnable task with a custom name such as `run-api`. The normal startup ranks are `dev` (0), `start` (1), `serve` (2), `run` (3), `up` (4), and `watch` (5). Set `argumentSeparator: '--'` if the tool needs a separator before forwarded application arguments. Build and test tasks should not get a startup rank. `isDefault` and `override` are reserved by convention for explicit project configuration.

## Adding a Node package manager

Implement `PackageManager` in `src/package-managers/`:

```ts
import type { PackageManager } from '../types.js';

export const customManager: PackageManager = {
  id: 'custom-pm',
  lockfiles: ['custom.lock'],
  runScript: (name) => ({
    bin: 'custom-pm',
    args: ['run', name],
    argumentSeparator: '--',
  }),
};
```

Register it in `src/package-managers/index.ts`. The Node runner uses the registry for both the `packageManager` field and lockfile detection. Tools from other ecosystems should get their own runner rather than going through the Node script detector.

For isolated tests, inject a runner list as the third argument to `detect(directory, platform, runners)` or pass a manager list to `createNodeRunner(managers)`. See `test/extensions.test.js` for tests that add integrations without changing core code.

## Adding a tunnel provider

Implement `TunnelProvider` in `src/publish/providers/`, then register it in that directory's `index.ts`. A provider defines its availability check, install hint, command for a loopback target, and public-URL parser. App startup, HTTP readiness, timeouts, signal handling, and cleanup stay in the shared publish session. The CLI selects providers with `--tunnel <id>`; project runners need no changes.

A provider can supply optional `ProviderInstaller` definitions with supported platforms, package-manager availability checks, install commands, and new PATH entries. Missing dependencies are installed only after the interactive CLI's `confirmInstall` callback approves the displayed command. Library callers omit this callback by default. Setup verifies the dependency again before starting the app; failed or declined installations never continue. Tests use fixture installers and never install system packages.

`publish(command, options, provider)` accepts an injected provider and an optional AbortSignal for programmatic cancellation. Use a local test proxy for integration tests rather than creating public Internet tunnels. `test/publish.test.js` verifies actual HTTP forwarding and cleanup, including subprocess trees and failure paths. Live Cloudflare availability is not a dependency of CI.

`openTunnel` is shared by foreground and dashboard publishing. It attaches to an existing HTTP origin and owns only the tunnel process. Dashboard publishing keeps the app alive when sharing is stopped or fails. Installer confirmation stays in the terminal client so the background manager never runs an interactive installer without a user present.

## Dashboard development

The dashboard uses Node's keypress events and ANSI alternate-screen rendering without npm runtime dependencies. Bare interactive `runa` opens it; direct task commands remain foreground invocations. Use `RUNA_STATE_DIR` to isolate a test manager from your real processes, and run `runa --shutdown` in the same environment when finished.

`ProcessManager` owns process/tunnel lifetimes independently of clients. RPC snapshots contain process metadata and bounded logs for one selected process; captured task environments stay private to the manager. The loopback server requires the token from the user's discovery file. Concurrent clients share a single daemon through an exclusive startup lock. Keep project detection and execution separate from rendering code.

`test/manager.test.js` verifies supervision, environment capture, restart, bounded logs, and publishing without app restarts. `test/daemon.test.js` verifies shared clients and local authentication. `test/tui.test.js` checks rendering, narrow layouts, and terminal-output sanitization. For manual testing, exercise start, detach/reconnect from a second directory, selection, log scrolling, publish/unpublish, restart, and shutdown confirmation in a real terminal.

## Agent API development

`runa agent` is a non-interactive client of the same daemon RPC used by the dashboard. Keep its JSON envelope versioned and expose operations through `src/agent/schema.ts`; `capabilities` uses this registry. Machine commands must not write human progress messages, task output, ANSI escapes, or installation prompts to stdout. Wrap failures in a stable error code; do not leak stack traces or captured environments.

Agent waits and follow streams accept bounded deadlines and cancellation. Cancelling a client must not kill managed apps. Cursor reads use completed log sequence numbers; partial output remains separate so polling never loses or duplicates completed lines. Retain sequence continuity across restarts. Changing the agent RPC requires an explicit capability/version check so older running daemons are not silently replaced while supervising user tasks.

`test/agent.test.js` exercises the compiled CLI against an isolated daemon, with dashboard RPC snapshots proving both clients see the same state. It checks JSON discovery, argument forwarding, cursor reads, bounded following, readiness timeouts, exit codes, sharing, and lifecycle controls. Tunnel binaries in these fixtures are local fakes, with PATH isolated from real tools. Package smoke tests also verify agent discovery from the installed tarball.

## Build and package checks

`npm ci` installs development tools and builds the CLI through `prepare`. `npm run check` type-checks without emitting files. `npm run test:package` creates a tarball, installs it into a temporary prefix with lifecycle scripts disabled, and verifies both CLI aliases and the compiled API. This ensures installed users do not need TypeScript or a build step. Do not commit generated `dist/` files.

## Pull requests

Fork the repository and make your changes on a branch. Describe the problem, the resulting behavior, and how you verified it in the pull request.

For changes to detection or process execution, add a focused test using a temporary project. Discovery must read project files without executing project code. Keep macOS, Linux, and Windows behavior in mind, especially argument passing, paths with spaces, and exit codes. Update the README when adding support for a project type or changing CLI behavior.

CI checks linting, formatting, types, tests, and package installation on all three operating systems. Contributions are made under the repository's [MIT license](LICENSE).
