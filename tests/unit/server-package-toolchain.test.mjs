import { describe, expect, it } from 'vitest';
import { resolveServerToolchain } from '../../scripts/server-package-toolchain.mjs';

describe('server package toolchain provenance', () => {
  it('supports compiler wrappers and records the exact selected Python path', async () => {
    const result = await resolveServerToolchain('/unused', {
      environment: { PATH: process.env.PATH, CXX: `env ${process.execPath}` },
      findPython: async () => process.execPath,
    });
    expect(result.provenance.compiler.version).toBe(process.version);
    expect(result.provenance.python).toEqual({ path: process.execPath, version: process.version });
    expect(result.environment.CXX_target).toBe(`env ${process.execPath}`);
    expect(result.environment.PYTHON).toBe(process.execPath);
    expect(result.provenance.limitations).toEqual([]);
  });
  it('pins Linux make default g++ and reports probe failures without losing the build', async () => {
    const result = await resolveServerToolchain('/unused', {
      platform: 'linux', environment: {}, findPython: async () => '/selected/python',
      run: async () => { throw Object.assign(new Error('unavailable'), { code: 'ENOENT' }); },
    });
    expect(result.environment.CXX).toBe('g++');
    expect(result.provenance.compiler).toEqual({ command: 'g++', version: null });
    expect(result.provenance.limitations).toHaveLength(3);
  });
  it('uses node-gyp target compiler precedence and fails Python discovery before building', async () => {
    const result = await resolveServerToolchain('/unused', {
      environment: { CXX_target: 'target-g++', CXX: 'host-g++' },
      findPython: async () => '/python', run: async () => ({ stdout: 'version' }),
    });
    expect(result.provenance.compiler.command).toBe('target-g++');
    await expect(resolveServerToolchain('/unused', {
      findPython: async () => { throw new Error('Python missing'); },
    })).rejects.toThrow('Python missing');
  });
});
