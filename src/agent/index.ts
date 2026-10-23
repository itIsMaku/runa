import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isRecord } from '../context.js';
import { connectDaemon } from '../daemon/client.js';
import type { DaemonClient, ProcessInfo, ProcessLogs, Snapshot } from '../daemon/types.js';
import { detect, select } from '../detect.js';
import { RunaError } from '../errors.js';
import { ensureProvider } from '../publish/provider-setup.js';
import { findTunnelProvider } from '../publish/providers/index.js';
import { type AgentCommand, agentCommands, agentHelp } from './schema.js';
import { terminal, type WaitState, waitForState, waitStates } from './wait.js';

interface Options {
  command: AgentCommand;
  operands: string[];
  args: string[];
  cwd?: string;
  timeout: number;
  tail: number;
  after?: number;
  follow: boolean;
  waitReady: boolean;
  noWait: boolean;
  port?: number;
  condition: WaitState;
}

const streamed = Symbol('streamed');
const emit = (result: unknown): void => {
  process.stdout.write(`${JSON.stringify({ version: 1, ok: true, result })}\n`);
};

function integer(
  value: string | undefined,
  flag: string,
  minimum: number,
  maximum: number,
): number {
  if (
    value === undefined ||
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < minimum ||
    Number(value) > maximum
  ) {
    throw new RunaError(
      'INVALID_ARGUMENT',
      `${flag} requires an integer from ${minimum} to ${maximum}.`,
    );
  }
  return Number(value);
}

function parse(argv: readonly string[]): Options {
  const command = argv[0];
  if (!command || !Object.hasOwn(agentCommands, command)) {
    throw new RunaError(
      'INVALID_ARGUMENT',
      `Unknown agent command "${command ?? ''}". Use runa agent capabilities or --help.`,
    );
  }
  const options: Options = {
    command: command as AgentCommand,
    operands: [],
    args: [],
    timeout: 30000,
    tail: 100,
    follow: false,
    waitReady: false,
    noWait: false,
    condition: 'ready',
  };
  const allowed: readonly string[] = agentCommands[options.command].flags;
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === undefined) {
      break;
    }
    if (arg === '--') {
      if (command !== 'start') {
        throw new RunaError(
          'INVALID_ARGUMENT',
          'Only agent start accepts forwarded task arguments.',
        );
      }
      options.args = argv.slice(index + 1);
      break;
    }
    if (arg === '--json') {
      continue;
    }
    if (!arg.startsWith('-')) {
      options.operands.push(arg);
      continue;
    }
    const flag = arg === '-C' ? 'cwd' : arg.slice(2);
    if (!allowed.includes(flag) || (arg !== '-C' && !arg.startsWith('--'))) {
      throw new RunaError('INVALID_ARGUMENT', `Unknown option "${arg}" for agent ${command}.`);
    }
    if (flag === 'follow') {
      options.follow = true;
    } else if (flag === 'wait-ready') {
      options.waitReady = true;
    } else if (flag === 'no-wait') {
      options.noWait = true;
    } else {
      const value = argv[++index];
      if (flag === 'cwd') {
        if (!value || value.startsWith('-')) {
          throw new RunaError('INVALID_ARGUMENT', `${arg} requires a directory.`);
        }
        options.cwd = path.resolve(value);
      } else if (flag === 'timeout') {
        options.timeout = integer(value, arg, 1, 300000);
      } else if (flag === 'tail') {
        options.tail = integer(value, arg, 1, 1000);
      } else if (flag === 'after') {
        options.after = integer(value, arg, 0, Number.MAX_SAFE_INTEGER);
      } else if (flag === 'port') {
        options.port = integer(value, arg, 1, 65535);
      } else if (flag === 'for') {
        if (!waitStates.some((state) => state === value)) {
          throw new RunaError(
            'INVALID_ARGUMENT',
            '--for must be running, ready, exited, or published.',
          );
        }
        options.condition = value as WaitState;
      }
    }
  }
  const needsId = [
    'inspect',
    'logs',
    'stop',
    'restart',
    'remove',
    'publish',
    'unpublish',
    'wait',
  ].includes(command);
  if (
    (needsId && options.operands.length !== 1) ||
    (!needsId && options.operands.length > (command === 'start' ? 1 : 0))
  ) {
    throw new RunaError(
      'INVALID_ARGUMENT',
      `Usage: runa agent ${agentCommands[options.command].usage}`,
    );
  }
  return options;
}

async function connection(start: boolean, signal: AbortSignal): Promise<DaemonClient | undefined> {
  const client = await connectDaemon(start, undefined, signal);
  signal.throwIfAborted();
  if (client) {
    const ping = await client.request<unknown>({ action: 'ping' }, { signal });
    if (!isRecord(ping) || ping.agentApiVersion !== 1) {
      throw new RunaError(
        'DAEMON_UPGRADE_REQUIRED',
        'The running manager predates the agent API. When convenient, stop it with runa --shutdown and reopen runa; existing apps have been left running.',
      );
    }
  }
  return client;
}

async function followLogs(
  client: DaemonClient,
  id: string,
  options: Options,
  signal: AbortSignal,
): Promise<typeof streamed> {
  let cursor = options.after;
  let lastPending = '';
  let lastStatus = '';
  let terminalSeen = false;
  try {
    while (true) {
      signal.throwIfAborted();
      const page = await client.request<ProcessLogs>(
        { action: 'logs', id, after: cursor, limit: options.tail },
        { signal },
      );
      const pending = JSON.stringify(page.pending);
      if (
        cursor === undefined ||
        page.logs.length ||
        pending !== lastPending ||
        page.process.status !== lastStatus ||
        page.truncated
      ) {
        emit({ event: 'logs', id, ...page });
      }
      cursor = page.nextCursor;
      lastPending = pending;
      lastStatus = page.process.status;
      if (terminal(page.process) && !page.hasMore) {
        if (terminalSeen) {
          emit({ event: 'end', id, nextCursor: cursor, reason: 'exited', process: page.process });
          return streamed;
        }
        terminalSeen = true;
      }
      if (!page.hasMore) {
        await delay(150, undefined, { signal });
      }
    }
  } catch (error) {
    if (signal.aborted && signal.reason instanceof RunaError && signal.reason.code === 'TIMEOUT') {
      emit({ event: 'end', id, nextCursor: cursor ?? 0, reason: 'timeout' });
      return streamed;
    }
    throw error;
  }
}

async function execute(options: Options, signal: AbortSignal): Promise<unknown> {
  const cwd = options.cwd ?? process.cwd();
  if (options.command === 'capabilities') {
    return {
      agentApiVersion: 1,
      output: 'JSON (NDJSON for logs --follow)',
      commands: agentCommands,
      waitStates,
      defaultTimeoutMs: 30000,
      maxTimeoutMs: 300000,
      interactive: false,
    };
  }
  if (options.command === 'discover') {
    return detect(cwd);
  }
  let task: ReturnType<typeof select>;
  if (options.command === 'start') {
    const project = detect(cwd);
    try {
      task = select(project, options.operands[0]);
    } catch (error) {
      throw new RunaError('INVALID_TASK', error instanceof Error ? error.message : String(error));
    }
    if (!task) {
      throw new RunaError(
        project.candidates.length ? 'AMBIGUOUS_TASK' : 'NO_TASKS',
        'Specify a task from runa agent discover.',
        { tasks: project.candidates.map((candidate) => candidate.id) },
      );
    }
  }
  const client = await connection(options.command === 'start', signal);
  if (!client) {
    if (options.command === 'list') {
      return { processes: [] };
    }
    if (options.command === 'shutdown') {
      return { stopped: true, processes: 0 };
    }
    throw new RunaError(
      'NOT_FOUND',
      'No process manager is running. Start a task with runa agent start.',
    );
  }
  const id = options.operands[0] ?? '';
  if (options.command === 'list') {
    const snapshot = await client.request<Snapshot>({ action: 'snapshot' }, { signal });
    return {
      processes: snapshot.processes.filter(
        (process) => !options.cwd || process.cwd === options.cwd,
      ),
    };
  }
  if (options.command === 'start' && task) {
    const info = await client.request<ProcessInfo>(
      {
        action: 'start',
        cwd: path.resolve(cwd),
        task: task.id,
        args: options.args,
        env: { ...process.env },
      },
      { signal },
    );
    return options.waitReady ? waitForState(client, info.id, 'ready', signal) : info;
  }
  if (options.command === 'inspect') {
    return client.request({ action: 'inspect', id }, { signal });
  }
  if (options.command === 'logs') {
    return options.follow
      ? followLogs(client, id, options, signal)
      : client.request(
          { action: 'logs', id, after: options.after, limit: options.tail },
          { signal },
        );
  }
  if (options.command === 'wait') {
    return waitForState(client, id, options.condition, signal, options.port);
  }
  if (options.command === 'shutdown') {
    await client.request({ action: 'shutdown' }, { signal });
    return { stopped: true };
  }
  if (options.command === 'publish') {
    const info = await client.request<ProcessInfo>({ action: 'inspect', id }, { signal });
    if (info.status !== 'running') {
      throw new RunaError('CONFLICT', 'Start the process before publishing it.', { process: info });
    }
    if (info.shareStatus === 'live' && info.publicUrl) {
      return info;
    }
    if (info.shareStatus === 'starting') {
      return options.noWait ? info : waitForState(client, id, 'published', signal);
    }
    try {
      await ensureProvider(findTunnelProvider(), info.cwd, {}, signal, () => {});
    } catch (error) {
      signal.throwIfAborted();
      throw new RunaError(
        'DEPENDENCY_UNAVAILABLE',
        error instanceof Error ? error.message : String(error),
        { process: info },
      );
    }
    await client.request(
      { action: 'publish', id, port: options.port, env: { ...process.env } },
      { signal },
    );
    return options.noWait
      ? client.request({ action: 'inspect', id }, { signal })
      : waitForState(client, id, 'published', signal);
  }
  if (['stop', 'restart', 'remove', 'unpublish'].includes(options.command)) {
    const action = options.command as 'stop' | 'restart' | 'remove' | 'unpublish';
    await client.request({ action, id }, { signal });
    if (action === 'remove') {
      return { removed: id };
    }
    return action === 'restart' && options.waitReady
      ? waitForState(client, id, 'ready', signal)
      : client.request({ action: 'inspect', id }, { signal });
  }
  throw new RunaError('INVALID_ARGUMENT', 'Unsupported agent command.');
}

export async function runAgent(argv: readonly string[]): Promise<number> {
  const separator = argv.indexOf('--');
  const control = separator < 0 ? argv : argv.slice(0, separator);
  if (!argv.length || argv[0] === 'help' || control.includes('--help') || control.includes('-h')) {
    console.log(agentHelp());
    return 0;
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () =>
    controller.abort(
      new RunaError('CANCELLED', 'Agent command interrupted; managed processes were left running.'),
    );
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  try {
    const options = parse(argv);
    timer = setTimeout(
      () =>
        controller.abort(
          new RunaError(
            'TIMEOUT',
            `Agent command timed out after ${options.timeout}ms. Managed processes were left running.`,
          ),
        ),
      options.timeout,
    );
    const result = await execute(options, controller.signal);
    if (result !== streamed) {
      controller.signal.throwIfAborted();
      emit(result);
    }
    return 0;
  } catch (error) {
    const cause =
      error instanceof RunaError
        ? error
        : controller.signal.aborted
          ? controller.signal.reason
          : error;
    const code = cause instanceof RunaError ? cause.code : 'COMMAND_FAILED';
    process.stdout.write(
      `${JSON.stringify({ version: 1, ok: false, error: { code, message: cause instanceof Error ? cause.message : String(cause), details: cause instanceof RunaError ? cause.details : undefined } })}\n`,
    );
    return code === 'TIMEOUT' ? 124 : code === 'CANCELLED' ? 130 : 1;
  } finally {
    clearTimeout(timer);
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
}
