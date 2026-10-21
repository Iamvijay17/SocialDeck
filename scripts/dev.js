#!/usr/bin/env node
// Runs API, worker and web dev server together with prefixed output. Ctrl+C stops everything.
import { spawn } from 'node:child_process';

const procs = [
  ['api', ['run', 'dev', '-w', '@osh/api'], '\x1b[36m'],
  ['worker', ['run', 'dev', '-w', '@osh/worker'], '\x1b[35m'],
  ['web', ['run', 'dev', '-w', '@osh/web'], '\x1b[32m'],
];

let stopping = false;
const children = procs.map(([name, args, color]) => {
  const child = spawn('npm', args, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = (stream) =>
    stream.on('data', (d) =>
      String(d)
        .split(/\r?\n/)
        .filter(Boolean)
        .forEach((l) => console.log(`${color}[${name}]\x1b[0m ${l}`)),
    );
  out(child.stdout);
  out(child.stderr);
  child.on('exit', (code) => {
    console.log(`${color}[${name}]\x1b[0m exited with code ${code}`);
    stop();
  });
  return child;
});

function stop() {
  if (stopping) return;
  stopping = true;
  for (const c of children) {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
    else c.kill('SIGTERM');
  }
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
