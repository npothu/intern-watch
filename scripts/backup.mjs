// Capture CLI output so deployment environment values never enter Actions logs.
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { encryptBackup } from './backup-crypto.mjs';

const destination = resolve(process.argv[2] ?? 'backup.iwbackup');
if (!process.env.BACKUP_PUBLIC_KEY) throw new Error('BACKUP_PUBLIC_KEY is required');
const deployment = process.env.BACKUP_DEPLOYMENT;
const selector = deployment ? ['--deployment', deployment] : ['--prod'];
const convex = resolve('node_modules/.bin/convex');
const scratch = await mkdtemp(join(tmpdir(), 'iw-backup-'));
const run = (args) => {
  try {
    return execFileSync(convex, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
  } catch {
    throw new Error(`Convex ${args[0]} failed. Check deployment permissions; output withheld to protect credentials.`);
  }
};
try {
  const environment = run(['env', 'list', ...selector]);
  await writeFile(join(scratch, 'convex.env.txt'), environment, { mode: 0o600 });
  run(['export', ...selector, '--include-file-storage', '--path', join(scratch, 'snapshot.zip')]);
  await writeFile(join(scratch, 'manifest.json'), JSON.stringify({
    version: 1, createdAt: new Date().toISOString(), deployment: deployment ?? 'prod',
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    includes: ['Convex tables', 'Convex file storage', 'Convex environment variables'],
    excludes: ['Vercel configuration', 'Clerk configuration', 'Google Cloud configuration', 'scheduled functions', 'GitHub secrets'],
  }, null, 2), { mode: 0o600 });
  const archive = join(scratch, 'bundle.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', scratch, 'manifest.json', 'snapshot.zip', 'convex.env.txt'], { stdio: 'pipe', env: { ...process.env, COPYFILE_DISABLE: '1' } });
  await encryptBackup(archive, destination, process.env.BACKUP_PUBLIC_KEY);
  console.log('Encrypted database, files, and Convex environment backup created.');
} finally {
  await rm(scratch, { recursive: true, force: true });
}
