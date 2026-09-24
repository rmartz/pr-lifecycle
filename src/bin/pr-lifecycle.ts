#!/usr/bin/env node
import { runCli } from '../cli.js';

process.exitCode = await runCli(
  process.argv.slice(2),
  {
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
  },
  { env: process.env },
);
