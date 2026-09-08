import { expect, test } from 'vitest';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encryptBackup, decryptBackup } from './backup-crypto.mjs';

// RSA key generation has variable CPU cost on shared CI runners.
test('backup round trip authenticates every byte and does not overwrite existing recovery files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'iw-backup-test-'));
  try {
    const keys = generateKeyPairSync('rsa', { modulusLength: 3072 });
    const source = join(dir, 'source');
    const encrypted = join(dir, 'backup');
    const restored = join(dir, 'restored');
    const bytes = randomBytes(1024 * 1024);
    await writeFile(source, bytes);
    await encryptBackup(source, encrypted, keys.publicKey);
    await decryptBackup(encrypted, restored, keys.privateKey);
    expect(await readFile(restored)).toEqual(bytes);
    await expect(decryptBackup(encrypted, restored, keys.privateKey)).rejects.toThrow();
    expect(await readFile(restored)).toEqual(bytes);
    const tampered = await readFile(encrypted);
    tampered[tampered.length - 20] ^= 1;
    await writeFile(join(dir, 'corrupt'), tampered);
    await expect(decryptBackup(join(dir, 'corrupt'), join(dir, 'bad'), keys.privateKey)).rejects.toThrow();
    await expect(access(join(dir, 'bad'))).rejects.toThrow();
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 30_000);
