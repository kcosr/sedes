import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const verifier = new URL('../../scripts/verify-server-package.mjs', import.meta.url).href;

function run(mode) {
  // A referenced MessagePort models node-pty's Windows ConoutConnection: a
  // shell's exit does not dispose its output worker. The child must exit
  // naturally after the probe releases its owned resource through kill().
  const source = `
    import assert from 'node:assert/strict';
    import { MessageChannel } from 'node:worker_threads';
    const { verifyRuntimePty } = await import(${JSON.stringify(verifier)});
    const probe = new Function('return (' + verifyRuntimePty.toString() + ')')();
    const mode = ${JSON.stringify(mode)};
    const channel = new MessageChannel();
    channel.port1.on('message', () => {});
    let killed = false;
    let dataDisposed = false;
    let exitDisposed = false;
    const close = () => { channel.port1.close(); channel.port2.close(); };
    const terminal = {
      onData(listener) {
        const delivery = setImmediate(() => listener(mode === 'bad-output' ? 'wrong output' : 'sedes_package_pty_ok'));
        return { dispose() { clearImmediate(delivery); dataDisposed = true; } };
      },
      onExit(listener) {
        const delivery = setImmediate(() => listener({ exitCode: mode === 'bad-exit' ? 9 : 0 }));
        return { dispose() { clearImmediate(delivery); exitDisposed = true; } };
      },
      kill() {
        assert.equal(killed, false, 'duplicate cleanup');
        killed = true;
        close();
        if (mode === 'cleanup-failure') throw new Error('PTY cleanup failed');
      },
    };
    try {
      await probe({ spawn: () => terminal }, process.cwd());
      assert.equal(mode, 'success', 'probe accepted an invalid result');
      assert.ok(killed && dataDisposed && exitDisposed, 'probe did not release its owned PTY');
      console.log('probe completed naturally');
    } catch (error) {
      // Close only on a failing assertion so the test reports that assertion
      // rather than leaving a fixture resource alive until the parent timeout.
      close();
      assert.ok(killed && dataDisposed && exitDisposed, 'probe did not release its owned PTY on failure');
      throw error;
    }
  `;
  return execute(process.execPath, ['--input-type=module', '--eval', source], { timeout: 3000 });
}

describe('packaged PTY probe ownership', () => {
  it('releases the worker and subscriptions after shell exit and completes naturally', async () => {
    await expect(run('success')).resolves.toMatchObject({ stdout: 'probe completed naturally\n', stderr: '' });
  });

  it.each(['bad-output', 'bad-exit'])('releases resources while retaining %s failure', async mode => {
    await expect(run(mode)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('PTY output/exit invalid') });
  });

  it('does not hide an owned resource cleanup failure', async () => {
    await expect(run('cleanup-failure')).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('PTY cleanup failed') });
  });
});
