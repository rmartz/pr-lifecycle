import { describe, expect, it } from 'vitest';

import { runCli, USAGE } from '../src/cli.js';

function makeIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { stdout: (line: string) => out.push(line), stderr: (line: string) => err.push(line) },
  };
}

describe('runCli', () => {
  it.each([[[]], [['help']], [['--help']], [['-h']]])('prints usage for %j', (argv) => {
    const { out, io } = makeIo();

    runCli(argv, io);

    expect(out).toEqual([USAGE]);
  });

  it('exits 0 when showing help', () => {
    const { io } = makeIo();

    expect(runCli(['help'], io)).toBe(0);
  });

  it('exits 2 on an unknown command', () => {
    const { io } = makeIo();

    expect(runCli(['frobnicate'], io)).toBe(2);
  });

  it('names the unknown command on stderr', () => {
    const { err, io } = makeIo();

    runCli(['frobnicate'], io);

    expect(err[0]).toBe('Unknown command: frobnicate');
  });
});
