import { emitKeypressEvents, type Key } from 'node:readline';
import { connectDaemon } from '../daemon/client.js';
import type { ProcessInfo, Snapshot } from '../daemon/types.js';
import { detect } from '../detect.js';
import { promptForInstall } from '../publish/install-prompt.js';
import { validatePort } from '../publish/local-url.js';
import { ensureProvider } from '../publish/provider-setup.js';
import { findTunnelProvider } from '../publish/providers/index.js';
import { type DashboardModel, type Modal, renderDashboard } from './render.js';

export async function runDashboard(cwd: string): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      'The dashboard requires an interactive terminal. Use runa --list or runa --run instead.',
    );
  }
  const connection = await connectDaemon();
  if (!connection) {
    throw new Error('Could not start the process manager.');
  }
  const client = connection;
  return new Promise<number>((resolve) => {
    let snapshot: Snapshot = { processes: [], logs: [] };
    let selected: string | undefined;
    let modal: Modal | undefined;
    let scroll = 0;
    let message = 'Press n to detect and start a task in this directory.';
    let busy = false;
    let connected = true;
    let closed = false;
    let paused = false;
    let polling = false;
    let lastFrame = '';
    let operation: AbortController | undefined;
    const wasRaw = process.stdin.isRaw;

    function draw(): void {
      if (closed || paused) {
        return;
      }
      const model: DashboardModel = {
        cwd,
        snapshot,
        selected,
        modal,
        scroll,
        message,
        busy,
        connected,
      };
      const frame = renderDashboard(
        model,
        Math.max(1, (process.stdout.columns || 100) - 1),
        Math.max(1, (process.stdout.rows || 30) - 1),
      );
      if (frame !== lastFrame) {
        lastFrame = frame;
        process.stdout.write(`\x1b[H${frame}\x1b[J`);
      }
    }

    function enter(): void {
      if (closed) {
        return;
      }
      paused = false;
      lastFrame = '';
      process.stdout.write('\x1b[?1049h\x1b[?25l');
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on('keypress', keypress);
      draw();
    }

    function pause(): void {
      paused = true;
      process.stdin.off('keypress', keypress);
      process.stdin.setRawMode(wasRaw ?? false);
      process.stdout.write('\x1b[0m\x1b[?25h\x1b[?1049l');
    }

    function finish(code = 0, stoppedAll = false): void {
      if (closed) {
        return;
      }
      closed = true;
      operation?.abort(new Error('Dashboard closed.'));
      clearInterval(interval);
      process.stdin.off('keypress', keypress);
      process.stdin.setRawMode(wasRaw ?? false);
      process.stdin.pause();
      process.stdout.off('resize', draw);
      process.off('SIGTERM', interrupt);
      process.off('SIGINT', interrupt);
      if (!paused) {
        process.stdout.write('\x1b[0m\x1b[?25h\x1b[?1049l');
      }
      console.log(
        stoppedAll
          ? 'runa: All managed processes and tunnels stopped.'
          : 'runa: Dashboard detached. Apps and tunnels stay in the background. Reopen with runa, or stop them with runa --shutdown.',
      );
      resolve(code);
    }
    const interrupt = () => finish(130);

    async function refresh(): Promise<void> {
      if (polling || closed) {
        return;
      }
      polling = true;
      const requested = selected;
      try {
        const next = await client.request<Snapshot>({ action: 'snapshot', selected: requested });
        const processes = [...next.processes].sort(
          (a, b) =>
            Number(b.status === 'running') - Number(a.status === 'running') ||
            b.startedAt - a.startedAt,
        );
        if (!processes.some((entry) => entry.id === selected)) {
          selected = processes[0]?.id;
          scroll = 0;
        }
        snapshot = { processes, logs: requested === selected ? next.logs : [] };
        connected = true;
      } catch (error) {
        connected = false;
        message = `${error instanceof Error ? error.message : String(error)} Close and reopen runa to reconnect.`;
      } finally {
        polling = false;
        draw();
      }
    }

    function act(action: () => Promise<void>): void {
      if (busy) {
        return;
      }
      busy = true;
      operation = new AbortController();
      draw();
      void action()
        .catch((error: unknown) => {
          message = error instanceof Error ? error.message : String(error);
        })
        .finally(() => {
          busy = false;
          operation = undefined;
          if (paused) {
            enter();
          }
          void refresh();
          draw();
        });
    }

    async function share(entry: ProcessInfo, port?: number): Promise<void> {
      const provider = findTunnelProvider();
      const signal = operation?.signal;
      if (!signal) {
        return;
      }
      await ensureProvider(
        provider,
        cwd,
        {
          confirmInstall: async (request, installSignal) => {
            pause();
            return promptForInstall(request, installSignal);
          },
        },
        signal,
        (text) => {
          message = text;
          if (paused) {
            console.error(`runa: ${text}`);
          }
        },
      );
      signal.throwIfAborted();
      await client.request({ action: 'publish', id: entry.id, port, env: { ...process.env } });
      message =
        'Connecting tunnel. Anyone with the public URL can access this app (p stops sharing).';
    }

    function keypress(rawInput: string | undefined, key: Key): void {
      const input = rawInput ?? '';
      if (key.ctrl && key.name === 'c') {
        finish(130);
        return;
      }
      if ((process.stdout.columns || 100) < 41 || (process.stdout.rows || 30) < 19) {
        if (input === 'q' || key.name === 'escape') {
          finish();
        }
        return;
      }
      if (busy) {
        return;
      }
      if (modal) {
        const current = modal;
        if (key.name === 'escape' || (current.kind === 'shutdown' && input.toLowerCase() === 'n')) {
          modal = undefined;
        } else if (current.kind === 'tasks') {
          if (key.name === 'up') {
            modal = { ...current, index: Math.max(0, current.index - 1) };
          } else if (key.name === 'down') {
            modal = { ...current, index: Math.min(current.tasks.length - 1, current.index + 1) };
          } else if (key.name === 'return') {
            const task = current.tasks[current.index];
            if (task) {
              modal = undefined;
              act(async () => {
                const entry = await client.request<ProcessInfo>({
                  action: 'start',
                  cwd,
                  task: task.id,
                  env: { ...process.env },
                });
                selected = entry.id;
                scroll = 0;
                message = `Started ${task.id}.`;
              });
            }
          }
        } else if (current.kind === 'port') {
          if (key.name === 'backspace' || key.name === 'delete') {
            modal = { ...current, value: current.value.slice(0, -1) };
          } else if (key.name === 'return') {
            try {
              const port = validatePort(current.value);
              const entry = snapshot.processes.find((item) => item.id === selected);
              modal = undefined;
              if (entry) {
                act(() => share(entry, port));
              }
            } catch (error) {
              message = error instanceof Error ? error.message : String(error);
            }
          } else if (/^\d+$/.test(input) && current.value.length + input.length <= 5) {
            modal = { ...current, value: current.value + input };
          }
        } else if (input.toLowerCase() === 'y') {
          act(async () => {
            await client.request({ action: 'shutdown' });
            finish(0, true);
          });
        }
        draw();
        return;
      }
      const entry = snapshot.processes.find((item) => item.id === selected);
      const index = snapshot.processes.findIndex((item) => item.id === selected);
      if (input === 'q' || key.name === 'escape') {
        finish();
      } else if (input === 'Q') {
        modal = { kind: 'shutdown' };
      } else if (input === 'n') {
        try {
          const project = detect(cwd);
          if (project.candidates.length === 0) {
            message = 'No tasks detected here. Add .runany.json to define a command.';
          } else {
            modal = {
              kind: 'tasks',
              tasks: project.candidates,
              index: 0,
              defaultId: project.defaultId,
            };
          }
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }
      } else if (key.name === 'up' || key.name === 'down') {
        selected =
          snapshot.processes[
            Math.max(
              0,
              Math.min(snapshot.processes.length - 1, index + (key.name === 'down' ? 1 : -1)),
            )
          ]?.id;
        scroll = 0;
        snapshot = { ...snapshot, logs: [] };
        void refresh();
      } else if (key.name === 'pageup') {
        scroll = Math.min(10000, scroll + 10);
      } else if (key.name === 'pagedown') {
        scroll = Math.max(0, scroll - 10);
      } else if (key.name === 'end') {
        scroll = 0;
      } else if (entry && input === 's') {
        act(async () => {
          await client.request({ action: 'stop', id: entry.id });
          message = 'Process stopped.';
        });
      } else if (entry && input === 'r') {
        act(async () => {
          await client.request({ action: 'restart', id: entry.id });
          scroll = 0;
          message = 'Process restarted.';
        });
      } else if (entry && input === 'd') {
        act(async () => {
          await client.request({ action: 'remove', id: entry.id });
          message = 'Process removed from history.';
        });
      } else if (entry && input === 'p') {
        if (entry.shareStatus === 'live' || entry.shareStatus === 'starting') {
          act(async () => {
            await client.request({ action: 'unpublish', id: entry.id });
            message = 'Sharing stopped. The app is still running.';
          });
        } else if (entry.status !== 'running') {
          message = 'Start the process before publishing it.';
        } else if (!entry.localUrl) {
          modal = { kind: 'port', value: '' };
        } else {
          act(() => share(entry));
        }
      }
      draw();
    }

    // Installation prompts reuse the existing foreground UX; cancellation stays local to this client.
    const interval = setInterval(() => {
      void refresh();
    }, 300);
    emitKeypressEvents(process.stdin);
    process.stdout.on('resize', draw);
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', interrupt);
    enter();
    void refresh();
  });
}
