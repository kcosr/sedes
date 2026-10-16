import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const verifier = new URL('../../scripts/verify-server-package.mjs', import.meta.url).href;

function run(mode, platform = 'win32') {
  // A referenced MessagePort models node-pty's Windows ConoutConnection: a
  // shell's exit does not dispose its output worker. The child must exit
  // naturally after the probe releases its owned resource through kill().
  const source = `
    import assert from 'node:assert/strict';
    import { MessageChannel } from 'node:worker_threads';
    const { verifyRuntimePty } = await import(${JSON.stringify(verifier)});
    const probe = new Function('return (' + verifyRuntimePty.toString() + ')')();
    Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });
    const mode = ${JSON.stringify(mode)};
    const expectedKill = process.platform === 'win32' || mode === 'registration-failure';
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
        if (mode === 'registration-failure') throw new Error('PTY subscription failed');
        const delivery = setImmediate(() => {
          // A POSIX PTY has already reaped the shell when it reports exit.
          if (process.platform !== 'win32') close();
          listener({ exitCode: mode === 'bad-exit' ? 9 : 0 });
        });
        return { dispose() { clearImmediate(delivery); exitDisposed = true; } };
      },
      kill() {
        assert.ok(expectedKill, 'probe signalled an already exited POSIX terminal');
        assert.equal(killed, false, 'duplicate cleanup');
        killed = true;
        close();
        if (mode === 'cleanup-failure') throw new Error('PTY cleanup failed');
      },
    };
    try {
      await probe({ spawn: () => terminal }, process.cwd());
      assert.equal(mode, 'success', 'probe accepted an invalid result');
      assert.ok(killed === expectedKill && dataDisposed && exitDisposed, 'probe did not release its owned PTY');
      console.log('probe completed naturally');
    } catch (error) {
      // Close only on a failing assertion so the test reports that assertion
      // rather than leaving a fixture resource alive until the parent timeout.
      close();
      assert.ok(killed === expectedKill && dataDisposed && exitDisposed === (mode !== 'registration-failure'),
        'probe did not release its owned PTY on failure');
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

  it.each(['linux', 'darwin'])('does not signal a completed %s terminal', async platform => {
    await expect(run('success', platform)).resolves.toMatchObject({ stdout: 'probe completed naturally\n', stderr: '' });
    await expect(run('bad-exit', platform)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('PTY output/exit invalid') });
  });

  it.each(['win32', 'linux', 'darwin'])('cleans up the active %s terminal if subscription fails', async platform => {
    await expect(run('registration-failure', platform)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('PTY subscription failed') });
  });
});

it.each([...new Set([process.platform, 'win32'])])('lets the %s verification server close its resources and exit naturally', async platform => {
  const expectedShutdown = platform === 'win32' ? 'disconnect' : 'SIGTERM';
  const serverSource = `
    import assert from 'node:assert/strict';
    const keepAlive = setInterval(() => {}, 1000);
    let closing = false;
    const stop = mechanism => {
      if (closing) return;
      closing = true;
      assert.equal(mechanism, ${JSON.stringify(expectedShutdown)}, 'wrong shutdown mechanism');
      setTimeout(() => {
        clearInterval(keepAlive);
        console.log('owned server resources closed via ' + mechanism);
        if (process.connected) process.disconnect();
      }, 25);
    };
    process.on('SIGTERM', () => stop('SIGTERM'));
    process.on('disconnect', () => stop('disconnect'));
    process.send({ type: 'ready' });
  `;
  const source = `
    import assert from 'node:assert/strict';
    import { spawn } from 'node:child_process';
    const { requestRuntimeShutdown } = await import(${JSON.stringify(verifier)});
    const child = spawn(process.execPath, ['--input-type=module', '--eval', ${JSON.stringify(serverSource)}], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({code, signal})));
    const outputDrained = new Promise(resolve => child.stdout.once('end', resolve));
    try {
      await new Promise((resolve, reject) => {
        child.once('message', resolve);
        child.once('error', reject);
      });
      Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });
      requestRuntimeShutdown(child);
      assert.deepEqual(await exited, {code: 0, signal: null});
      await outputDrained;
      assert.ok(output.includes(${JSON.stringify('owned server resources closed via ' + expectedShutdown)}));
      if (process.platform === 'win32') {
        requestRuntimeShutdown({
          connected: false,
          disconnect() { throw new Error('disconnected Windows server was disconnected again'); },
          kill() { throw new Error('disconnected Windows server was signalled'); },
        });
      }
      console.log('server completed naturally');
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
    }
  `;
  await expect(execute(process.execPath, ['--input-type=module', '--eval', source], {timeout: 3000}))
    .resolves.toMatchObject({stdout: 'server completed naturally\n', stderr: ''});
});
