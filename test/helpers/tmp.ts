/**
 * Temporary directories for tests. Directories created by `makeTmpDir` are
 * tracked so one `cleanupTmpDirs()` in `afterEach`/`afterAll` removes them all.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const created = new Set<string>();

/** Creates a unique empty directory under the OS temp dir and returns its absolute path. */
export function makeTmpDir(prefix = 'rw-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.add(dir);
  return dir;
}

/** Removes one directory recursively. Retries because Windows can hold SQLite files briefly. */
export function removeTmpDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  created.delete(dir);
}

/** Removes every directory created by `makeTmpDir` and not yet removed. */
export function cleanupTmpDirs(): void {
  for (const dir of [...created]) removeTmpDir(dir);
}

/** Runs `fn` with a fresh directory and always removes it afterwards. */
export async function withTmpDir<T>(fn: (dir: string) => Promise<T> | T, prefix?: string): Promise<T> {
  const dir = makeTmpDir(prefix);
  try {
    return await fn(dir);
  } finally {
    removeTmpDir(dir);
  }
}
