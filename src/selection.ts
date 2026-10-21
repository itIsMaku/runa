import type { Candidate, Project } from './types.js';

const preferredNames = ['dev', 'start', 'serve', 'run', 'up', 'watch'];

export function defaultScore(candidate: Candidate): number {
  if (candidate.isDefault) {
    return -1;
  }
  const rank = candidate.defaultRank ?? preferredNames.indexOf(candidate.name);
  return rank >= 0 ? candidate.priority * 10 + rank : Infinity;
}

export function select(project: Project, requested?: string): Candidate | undefined {
  if (requested) {
    const exact = project.candidates.find((candidate) => candidate.id === requested);
    if (exact) {
      return exact;
    }
    const matches = project.candidates.filter((candidate) => candidate.name === requested);
    const overrides = matches.filter((candidate) => candidate.override);
    if (overrides.length === 1) {
      return overrides[0];
    }
    if (matches.length === 1) {
      return matches[0];
    }
    if (matches.length > 1) {
      throw new Error(
        `Task "${requested}" is ambiguous. Use ${matches.map((item) => item.id).join(' or ')}.`,
      );
    }
    throw new Error(`Unknown task "${requested}". Run runa --list to see available tasks.`);
  }
  return project.candidates.find((candidate) => candidate.id === project.defaultId);
}
