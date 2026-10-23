export const agentCommands = {
  capabilities: {
    usage: 'capabilities',
    description: 'Describe the agent API without starting a manager.',
    flags: [],
  },
  discover: {
    usage: 'discover [-C directory]',
    description: 'Discover project tasks without running them.',
    flags: ['cwd'],
  },
  list: {
    usage: 'list [-C directory]',
    description: 'List managed processes visible in the TUI.',
    flags: ['cwd'],
  },
  start: {
    usage: 'start [task] [-C directory] [--wait-ready] [-- arguments...]',
    description: 'Start a managed task and return its stable process ID.',
    flags: ['cwd', 'wait-ready', 'timeout'],
  },
  inspect: {
    usage: 'inspect <id>',
    description: 'Read process status, local/public URLs, and exit code.',
    flags: [],
  },
  logs: {
    usage: 'logs <id> [--tail 100] [--after cursor] [--follow] [--timeout 30000]',
    description: 'Read bounded cursor-based logs; follow emits NDJSON until exit or timeout.',
    flags: ['tail', 'after', 'follow', 'timeout'],
  },
  stop: { usage: 'stop <id>', description: 'Stop one process and its tunnel.', flags: [] },
  restart: {
    usage: 'restart <id> [--wait-ready] [--timeout 30000]',
    description: 'Restart one process, preserving its ID.',
    flags: ['wait-ready', 'timeout'],
  },
  remove: {
    usage: 'remove <id>',
    description: 'Remove a stopped process from history.',
    flags: [],
  },
  publish: {
    usage: 'publish <id> [--port 3000] [--no-wait] [--timeout 30000]',
    description: 'Share an existing app; return its public URL when available.',
    flags: ['port', 'no-wait', 'timeout'],
  },
  unpublish: {
    usage: 'unpublish <id>',
    description: 'Stop sharing while keeping the app running.',
    flags: [],
  },
  wait: {
    usage: 'wait <id> --for ready|running|exited|published [--port 3000] [--timeout 30000]',
    description: 'Wait for a bounded process condition.',
    flags: ['for', 'port', 'timeout'],
  },
  shutdown: { usage: 'shutdown', description: 'Stop every managed process and tunnel.', flags: [] },
} as const;

export type AgentCommand = keyof typeof agentCommands;

export function agentHelp(): string {
  return `runa agent — control the same processes as the TUI without a terminal

Usage: runa agent <command> [options]

${Object.values(agentCommands)
  .map((command) => `  ${command.usage}\n    ${command.description}`)
  .join('\n')}

JSON is the default; --json is accepted for explicitness. Responses use
{ "version": 1, "ok": true, "result": ... } or { "version": 1, "ok": false, "error": { "code", "message", "details"? } }.
logs --follow emits one JSON response per line. No commands open a TUI or prompt.
--timeout is in milliseconds (1–300000; default 30000). Timeouts exit 124;
interruptions exit 130; other errors exit 1. Managed apps keep running after a wait timeout.
Use capabilities for machine-readable command discovery.
`;
}
