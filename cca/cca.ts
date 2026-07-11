#!/usr/bin/env node
import { reportError } from "./src/core.ts";
import { run } from "./src/cli.ts";

run(process.argv.slice(2)).catch((error: unknown) => {
  reportError(error);
  process.exitCode = 1;
});
