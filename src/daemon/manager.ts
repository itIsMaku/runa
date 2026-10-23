import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { type ManagedProcess, startProcess } from '../managed-process.js';
import { formatCommand } from '../process.js';
import { findLocalUrl, localTarget, validatePort, waitForHttp } from '../publish/local-url.js';
import { findTunnelProvider } from '../publish/providers/index.js';
import { openTunnel } from '../publish/tunnel.js';
import type { TunnelProvider } from '../publish/types.js';
import { LogBuffer } from './logs.js';
import type { ProcessDefinition, ProcessInfo, Snapshot } from './types.js';

interface Entry {
  info: ProcessInfo;
  readonly definition: ProcessDefinition;
  readonly logs: LogBuffer;
  child?: ManagedProcess;
  sharing?: Promise<void>;
  controller?: AbortController;
  stopping?: Promise<void>;
}

export class ProcessManager {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly provider: TunnelProvider = findTunnelProvider()) {}

  start(definition: ProcessDefinition): ProcessInfo {
    if (this.entries.size >= 100) {
      throw new Error('Process history is full. Remove stopped processes first (d).');
    }
    const id = randomUUID();
    const entry: Entry = {
      definition,
      logs: new LogBuffer(),
      info: {
        id,
        cwd: definition.command.cwd,
        project: path.basename(definition.command.cwd),
        task: definition.task,
        command: formatCommand(definition.command.bin, definition.command.args),
        status: 'running',
        shareStatus: 'off',
        startedAt: Date.now(),
      },
    };
    this.entries.set(id, entry);
    this.launch(entry);
    return entry.info;
  }

  private launch(entry: Entry): void {
    entry.info = {
      ...entry.info,
      status: 'running',
      exitCode: undefined,
      localUrl: undefined,
      startedAt: Date.now(),
      shareStatus: 'off',
      shareError: undefined,
      publicUrl: undefined,
    };
    entry.logs.message(`Started ${entry.info.command}`);
    const pending = { stdout: '', stderr: '' };
    const child = startProcess(entry.definition.command, {
      onOutput: (text, stream) => {
        entry.logs.append(text, stream);
        pending[stream] = (pending[stream] + text).slice(-32768);
        const end = pending[stream].lastIndexOf('\n');
        if (end >= 0) {
          const url = findLocalUrl(pending[stream].slice(0, end + 1));
          pending[stream] = pending[stream].slice(end + 1);
          if (url) {
            entry.info = { ...entry.info, localUrl: url };
          }
        }
      },
    });
    entry.child = child;
    void child.exit
      .then(async (result) => {
        if (entry.child !== child) {
          return;
        }
        const stopped = ['stopping', 'stopped'].includes(entry.info.status);
        entry.logs.flush();
        entry.info = {
          ...entry.info,
          status: stopped ? 'stopped' : result.code === 0 && !result.error ? 'exited' : 'failed',
          exitCode: result.code,
        };
        entry.logs.message(
          result.error?.message ?? `Process ${stopped ? 'stopped' : 'exited'} (${result.code}).`,
        );
        await this.stopSharing(entry);
        await child.stop();
      })
      .catch((error: unknown) =>
        entry.logs.message(error instanceof Error ? error.message : String(error)),
      );
  }

  private get(id: string): Entry {
    const entry = this.entries.get(id);
    if (!entry) {
      throw new Error('Process no longer exists.');
    }
    return entry;
  }

  snapshot(selected?: string): Snapshot {
    return {
      processes: [...this.entries.values()].map((entry) => entry.info),
      logs: selected ? (this.entries.get(selected)?.logs.snapshot() ?? []) : [],
    };
  }

  async stop(id: string): Promise<void> {
    const entry = this.get(id);
    entry.stopping ??= (async () => {
      if (entry.info.status === 'running') {
        entry.info = { ...entry.info, status: 'stopping' };
      }
      await this.unpublish(id);
      await entry.child?.stop();
      if (entry.info.status === 'stopping') {
        entry.info = { ...entry.info, status: 'stopped' };
      }
    })();
    await entry.stopping;
  }

  async restart(id: string): Promise<void> {
    const entry = this.get(id);
    await this.stop(id);
    entry.stopping = undefined;
    this.launch(entry);
  }

  remove(id: string): void {
    const entry = this.get(id);
    if (['running', 'stopping'].includes(entry.info.status)) {
      throw new Error('Stop the process before removing it.');
    }
    this.entries.delete(id);
  }

  async publish(id: string, port: number | undefined, env: NodeJS.ProcessEnv): Promise<void> {
    const entry = this.get(id);
    if (entry.info.status !== 'running') {
      throw new Error('Start the process before publishing it.');
    }
    if (entry.sharing) {
      throw new Error('This process is already sharing or connecting.');
    }
    const target = port === undefined ? entry.info.localUrl : localTarget(validatePort(port));
    if (!target) {
      throw new Error('No local URL detected. Specify the app port.');
    }
    const controller = new AbortController();
    entry.controller = controller;
    entry.info = {
      ...entry.info,
      shareStatus: 'starting',
      shareError: undefined,
      publicUrl: undefined,
    };
    entry.sharing = (async () => {
      try {
        await waitForHttp(target, Date.now() + 30000, controller.signal);
        await openTunnel(
          target,
          entry.info.cwd,
          {
            onOutput: (text) => entry.logs.append(text, 'tunnel'),
            onPublicUrl: (url) => {
              entry.info = { ...entry.info, shareStatus: 'live', publicUrl: url };
              entry.logs.message(`Public URL: ${url}`);
            },
          },
          this.provider,
          controller.signal,
          env,
        );
      } catch (error) {
        if (!controller.signal.aborted) {
          const text = error instanceof Error ? error.message : String(error);
          entry.info = {
            ...entry.info,
            shareStatus: 'error',
            shareError: text,
            publicUrl: undefined,
          };
          entry.logs.message(text);
        }
      } finally {
        entry.sharing = undefined;
        entry.controller = undefined;
      }
    })();
  }

  async unpublish(id: string): Promise<void> {
    await this.stopSharing(this.get(id));
  }

  private async stopSharing(entry: Entry): Promise<void> {
    entry.controller?.abort(new Error('Sharing stopped.'));
    await entry.sharing;
    entry.info = { ...entry.info, shareStatus: 'off', publicUrl: undefined, shareError: undefined };
  }

  get active(): boolean {
    return [...this.entries.values()].some((entry) =>
      ['running', 'stopping'].includes(entry.info.status),
    );
  }

  async close(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((id) => this.stop(id)));
  }
}
