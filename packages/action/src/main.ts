import { gitReadAtRevision, run } from './run.ts';

const workspace = process.env['GITHUB_WORKSPACE'] ?? process.cwd();

run({ env: process.env, readAtRevision: gitReadAtRevision(workspace), log: (line) => console.log(line) })
  .then(({ exitCode }) => {
    process.exitCode = exitCode;
  })
  .catch((error: unknown) => {
    console.log(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
