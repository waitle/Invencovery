import os from 'node:os';
import { describe, expect, it, vi } from 'vitest';

// Captures what `runDoctor` hands to child_process.execFile when it runs the real `gh` runner.
const execCalls = vi.hoisted(() => [] as Array<{ file: string; args: string[]; options: Record<string, unknown> }>);
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: (file: string, args: string[], options: Record<string, unknown>, cb: (err: Error | null, stdout: string) => void) => {
      execCalls.push({ file, args, options });
      cb(null, args[0] === '--version' ? 'gh version 2.50.0\n' : 'gho_faketoken12345\n');
    },
  };
});

const { ghExecOptions, runDoctor } = await import('../../src/doctor.js');

describe('gh invocation hardening (M-6)', () => {
  it('ghExecOptions runs from the home directory with a no-cwd-lookup, no-prompt environment', () => {
    const o = ghExecOptions(3000, { PATH: '/bin', KEEP: 'me', NoDefaultCurrentDirectoryInExePath: '0' });
    expect(o.cwd).toBe(os.homedir());
    expect(o.env.NoDefaultCurrentDirectoryInExePath).toBe('1');
    expect(o.env.GH_PROMPT_DISABLED).toBe('1');
    expect((o.env as Record<string, string>).KEEP).toBe('me');
    expect(o).toMatchObject({ timeout: 3000, windowsHide: true, encoding: 'utf8' });
  });

  it('the default runner passes cwd and env to every gh call', async () => {
    execCalls.length = 0;
    const report = await runDoctor({
      env: { RECYCLEWHEEL_OFFLINE: '1', RECYCLEWHEEL_CACHE_DIR: os.tmpdir(), RECYCLEWHEEL_PROJECT_ROOT: os.tmpdir() },
      network: false,
    });
    expect(report.checks.find((c) => c.id === 'gh')?.level).toBe('ok');
    expect(execCalls.length).toBeGreaterThanOrEqual(1);
    for (const call of execCalls) {
      expect(call.file).toBe('gh');
      expect(call.options.cwd).toBe(os.homedir());
      const env = call.options.env as Record<string, string>;
      expect(env.NoDefaultCurrentDirectoryInExePath).toBe('1');
      expect(env.GH_PROMPT_DISABLED).toBe('1');
    }
  });
});
