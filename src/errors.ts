/** Stable machine-readable errors, shared by local RPC and the agent CLI. */
export class RunaError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'RunaError';
  }
}
