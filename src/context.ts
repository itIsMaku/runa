import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { DetectionContext } from './types.js';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function createContext(
  directory: string,
  platform: NodeJS.Platform = process.platform,
): DetectionContext {
  const cwd = path.resolve(directory);
  const contents = new Map<string, string>();
  const has = (file: string): boolean => {
    const absolute = path.join(cwd, file);
    return existsSync(absolute) && statSync(absolute).isFile();
  };
  const read = (file: string): string => {
    const cached = contents.get(file);
    if (cached !== undefined) {
      return cached;
    }
    const content = readFileSync(path.join(cwd, file), 'utf8');
    contents.set(file, content);
    return content;
  };
  return {
    cwd,
    platform,
    files: readdirSync(cwd).filter(has),
    has,
    read,
    readJson(file): unknown {
      try {
        return JSON.parse(read(file)) as unknown;
      } catch (error) {
        throw new Error(
          `Cannot read ${path.join(cwd, file)}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}
