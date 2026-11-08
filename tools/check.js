import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

let failed = false;
for (const dir of ['src', 'public', 'test', 'tools']) {
  for (const name of await readdir(dir)) {
    if (!/\.(?:js|cjs)$/.test(name)) continue;
    const result = spawnSync(process.execPath, ['--check', `${dir}/${name}`], { stdio: 'inherit' });
    if (result.status !== 0) failed = true;
  }
}
if (failed) process.exitCode = 1;
else console.log('JavaScript syntax checks passed.');
