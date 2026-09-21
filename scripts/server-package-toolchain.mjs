import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

/** Resolve before building, and pin the same selections into node-gyp's env. */
export async function resolveServerToolchain(repositoryRoot, {
  environment = process.env, platform = process.platform, run = execute, findPython,
} = {}) {
  const compiler = environment.CXX_target || environment.CXX || (platform === 'darwin' ? 'clang++' : 'g++');
  if (!findPython) {
    const require = createRequire(path.join(repositoryRoot, 'package.json'));
    const PythonFinder = require('node-gyp/lib/find-python.js');
    findPython = () => {
      const finder = new PythonFinder();
      finder.env = environment;
      return finder.findPython();
    };
  }
  const python = await findPython();
  const env = { ...environment, CXX: compiler, CXX_target: compiler, PYTHON: python };
  const limitations = [];
  async function probe(label, command, args) {
    try { return (await run(command, args, { env: { ...env, SEDES_CXX_PROBE: compiler }, timeout: 10_000 })).stdout.trim(); }
    catch (error) {
      limitations.push(`${label} version probe unavailable: ${error.code ?? error.message}`);
      return null;
    }
  }
  // CXX can contain a wrapper and flags, as accepted by make. Shell expansion
  // here is limited to word splitting; the value is never evaluated as code.
  const compilerVersion = await probe('compiler', '/bin/sh', ['-c', 'exec $SEDES_CXX_PROBE --version']);
  return {
    environment: env,
    provenance: {
      compiler: { command: compiler, version: compilerVersion },
      python: { path: python, version: await probe('Python', python, ['--version']) },
      npm: await probe('npm', 'npm', ['--version']),
      limitations,
    },
  };
}
