import type { Runner } from '../types.js';
import { cargoRunner } from './cargo.js';
import { composeRunner } from './compose.js';
import { configRunner } from './config.js';
import { dotnetRunner } from './dotnet.js';
import { goRunner } from './go.js';
import { makeRunner } from './make.js';
import { createNodeRunner } from './node.js';
import { pythonRunner } from './python.js';

/** Add a runner here; detection, selection and execution need no edits. */
export const builtinRunners: readonly Runner[] = [
  configRunner,
  createNodeRunner(),
  makeRunner,
  composeRunner,
  pythonRunner,
  cargoRunner,
  goRunner,
  dotnetRunner,
];

export {
  cargoRunner,
  composeRunner,
  configRunner,
  createNodeRunner,
  dotnetRunner,
  goRunner,
  makeRunner,
  pythonRunner,
};
