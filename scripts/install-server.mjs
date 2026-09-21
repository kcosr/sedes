#!/usr/bin/env node
// Offline installer for a versioned per-user Sedes server package.
// See `node scripts/install-server.mjs --help` and docs/operator/operations.md.
import { installServer } from "./install-server-lib.mjs";

process.exitCode = await installServer({ argv: process.argv.slice(2) });
