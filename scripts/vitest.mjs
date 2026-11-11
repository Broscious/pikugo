#!/usr/bin/env node
// Runs Vitest from a normalised working directory.
//
// On Windows a lower-case drive letter in the working directory (VS Code terminals
// often start in `c:\...`) makes Vitest load two copies of itself, and every suite
// fails with "Cannot read properties of undefined (reading 'config')".
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const cwd = process.cwd().replace(/^[a-z]:/, (drive) => drive.toUpperCase());
const require = createRequire(path.join(cwd, "package.json"));
const bin = path.join(path.dirname(require.resolve("vitest/package.json")), "vitest.mjs");
const { status } = spawnSync(process.execPath, [bin, ...process.argv.slice(2)], { cwd, stdio: "inherit" });
process.exit(status ?? 1);
