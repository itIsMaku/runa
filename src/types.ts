/** A command is data; discovering one must never execute it. */
export interface Command {
  readonly bin: string;
  readonly args: readonly string[];
  /** Insert before forwarded arguments, e.g. npm's `--`. */
  readonly argumentSeparator?: string;
}

export interface Task extends Command {
  readonly name: string;
  readonly source: string;
  /** Defaults to runner-id:task-name; Node scripts retain npm:dev etc. */
  readonly id?: string;
  readonly description?: string;
  /** Optional startup preference for names such as run-api (lower wins). */
  readonly defaultRank?: number;
  /** Explicit project-configured default. */
  readonly isDefault?: boolean;
  /** Explicit project configuration overrides matching short task names. */
  readonly override?: boolean;
}

export interface Candidate extends Task {
  readonly id: string;
  readonly priority: number;
}

export interface Project {
  readonly cwd: string;
  readonly candidates: readonly Candidate[];
  readonly defaultId?: string;
}

/** Read-only project access shared by all detectors. No process execution. */
export interface DetectionContext {
  readonly cwd: string;
  readonly platform: NodeJS.Platform;
  readonly files: readonly string[];
  has(file: string): boolean;
  read(file: string): string;
  readJson(file: string): unknown;
}

export interface Runner {
  readonly id: string;
  /** Runner preference; lower values take precedence. */
  readonly priority: number;
  detect(context: DetectionContext): readonly Task[];
}

export interface PackageManager {
  readonly id: string;
  readonly lockfiles: readonly string[];
  runScript(name: string): Command;
}

export interface ExecutableCommand extends Command {
  readonly cwd: string;
}
