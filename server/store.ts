import fs from 'node:fs';
import path from 'node:path';
import {ConfigError, normalizeInstance, type InstanceInput} from './config.js';
import type {InstanceConfig, InstanceDef} from './types.js';

/** Write a file atomically and owner-only (0600), leaving nothing behind on failure. */
export function writePrivateJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, {mode: 0o600});
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, {force: true}); // don't leave a partial file behind (e.g. disk full)
    throw err;
  }
}

/**
 * Instances added from the settings UI, persisted as JSON in the data directory.
 * The file holds Pi-hole passwords, so it is written owner-only (0600).
 */
export class InstanceStore {
  readonly dir: string;
  readonly file: string;

  constructor(dir: string) {
    this.dir = dir;
    this.file = path.join(dir, 'instances.json');
  }

  /** Whether settings can be saved; returns a reason string when they can't. */
  checkWritable(): string | null {
    try {
      fs.mkdirSync(this.dir, {recursive: true, mode: 0o700});
      fs.accessSync(this.dir, fs.constants.W_OK);
      return null;
    } catch {
      return `The data directory (${this.dir}) is not writable, so changes can't be saved. Mount a volume there.`;
    }
  }

  /** Load saved instances, skipping (and logging) any entry that no longer validates. */
  load(takenIds: Set<string>): InstanceDef[] {
    let list: unknown;
    try {
      list = (
        JSON.parse(fs.readFileSync(this.file, 'utf8')) as {instances?: unknown}
      ).instances;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') return [];
      console.error(
        `  Could not read ${this.file}: ${err.message}. Starting without saved instances.`,
      );
      return [];
    }
    if (!Array.isArray(list)) return [];
    const out: InstanceDef[] = [];
    for (const [i, inst] of (list as InstanceInput[]).entries()) {
      try {
        const n = normalizeInstance(inst, {
          label: `saved instance #${i + 1}`,
          takenIds,
        });
        takenIds.add(n.id);
        out.push({...n, source: 'ui'});
      } catch (err) {
        if (!(err instanceof ConfigError)) throw err;
        console.warn(`  Skipping ${err.message}`);
      }
    }
    return out;
  }

  /** Atomically replace the saved list. */
  save(instances: InstanceConfig[]): void {
    writePrivateJson(this.file, {
      version: 1,
      instances: instances.map(
        ({id, name, url, password, insecure, timeoutMs}) => ({
          id,
          name,
          url,
          password,
          insecure,
          timeoutMs,
        }),
      ),
    });
  }
}
