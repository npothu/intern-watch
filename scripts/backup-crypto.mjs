import { createCipheriv, createDecipheriv, publicEncrypt, privateDecrypt, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

const MAGIC = 'IWBACKUP1\n';

export async function encryptBackup(source, destination, publicKey) {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const header = Buffer.from(MAGIC + JSON.stringify({
    key: publicEncrypt({ key: publicKey, oaepHash: 'sha256' }, key).toString('base64'),
    iv: iv.toString('base64'),
  }) + '\n');
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(header);
  const output = createWriteStream(destination, { flags: 'wx', mode: 0o600 });
  output.write(header);
  await pipeline(createReadStream(source), cipher, output, { end: false });
  await new Promise((resolve, reject) => {
    output.once('error', reject);
    output.end(cipher.getAuthTag(), resolve);
  });
}

export async function decryptBackup(source, destination, privateKey) {
  const handle = await open(source, 'r');
  let created = false;
  try {
    const probe = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(probe, 0, probe.length, 0);
    if (probe.subarray(0, MAGIC.length).toString() !== MAGIC) throw new Error('Not an intern-watch backup');
    const end = probe.indexOf(10, MAGIC.length);
    if (end < 0 || end >= bytesRead) throw new Error('Invalid backup header');
    const header = probe.subarray(0, end + 1);
    const data = JSON.parse(probe.subarray(MAGIC.length, end).toString());
    const key = privateDecrypt({ key: privateKey, oaepHash: 'sha256' }, Buffer.from(data.key, 'base64'));
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(data.iv, 'base64'));
    decipher.setAAD(header);
    const size = (await stat(source)).size;
    if (size < header.length + 16) throw new Error('Truncated backup');
    const tag = Buffer.alloc(16);
    await handle.read(tag, 0, 16, size - 16);
    decipher.setAuthTag(tag);
    const output = createWriteStream(destination, { flags: 'wx', mode: 0o600 });
    output.once('open', () => { created = true; });
    await pipeline(createReadStream(source, { start: header.length, end: size - 17 }), decipher, output);
  } catch (error) {
    // Never leave unauthenticated plaintext behind after a failed decrypt.
    const { rm } = await import('node:fs/promises');
    if (created) await rm(destination, { force: true });
    throw error;
  } finally {
    await handle.close();
  }
}
