import { randomBytes } from 'node:crypto';
import { link, mkdir, open, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { hashPassword, validateUsername } from '../src/auth.mjs';

async function readPassword() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 1 || args[0] !== '--password-stdin')) {
    throw new Error('Usage: node scripts/init-owner.mjs [--password-stdin]');
  }
  if (args.length) {
    if (process.stdin.isTTY || process.env.OWNER_PASSWORD !== undefined) {
      throw new Error('Supply one password through a pipe or protected file on standard input.');
    }
    const parts = [];
    let length = 0;
    for await (const chunk of process.stdin) {
      length += chunk.length;
      if (length > 258) throw new Error('The supplied password is too long.');
      parts.push(chunk);
    }
    return { password: Buffer.concat(parts).toString('utf8').replace(/\r?\n$/, ''), generated: false };
  }
  if (process.env.OWNER_PASSWORD !== undefined) {
    const password = process.env.OWNER_PASSWORD;
    delete process.env.OWNER_PASSWORD;
    return { password, generated: false };
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('For unattended setup, pipe a secret using --password-stdin or supply OWNER_PASSWORD.');
  }
  return { password: randomBytes(24).toString('base64url'), generated: true };
}

export async function saveOwner({ username, password, dir }) {
  validateUsername(username);
  const passwordHash = await hashPassword(password);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temporary = join(dir, `.owner-${randomBytes(16).toString('hex')}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    try {
      await file.writeFile(JSON.stringify({ username, passwordHash }) + '\n');
      await file.sync();
    } finally {
      await file.close();
    }
    // Publish the complete file atomically. A simultaneous setup or existing owner wins.
    await link(temporary, join(dir, 'owner.json'));
  } finally {
    await unlink(temporary);
  }
}

async function initialize() {
  const username = process.env.OWNER_USERNAME ?? 'owner';
  const dir = resolve(process.env.DATA_DIR || '.local');
  const { password, generated } = await readPassword();
  await saveOwner({ username, password, dir });
  console.log(`Owner access initialized for ${username}.`);
  if (generated) console.log(`Save this password now: ${password}`);
}

if (import.meta.main) initialize().catch(error => {
  const message = error.code === 'EEXIST' ? 'Owner credentials already exist. Setup has left them intact.'
    : error.code ? 'Unable to initialize the owner credential file. Check data directory access.'
      : error.message;
  console.error(message);
  process.exitCode = 1;
});
