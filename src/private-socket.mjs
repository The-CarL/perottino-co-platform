import { randomUUID } from 'node:crypto';
import { chmod, readlink, rename, rm, symlink } from 'node:fs/promises';
import path from 'node:path';

export function listenServer(server, ...args) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(...args, () => { server.removeListener('error', reject); resolve(); });
  });
}

export async function listenPrivateSocket(server, socket) {
  if (!path.isAbsolute(socket) || Buffer.byteLength(socket) > 103 || socket.includes('\0'))
    throw new Error('Expected an absolute Unix socket path of at most 103 bytes.');
  // Each process binds its own inode. Publishing a relative symlink atomically
  // supports rolling replacement and crash recovery across host bind mounts.
  const parent = path.dirname(socket);
  const name = '.endpoint-' + randomUUID();
  const owned = path.join(parent, name);
  if (Buffer.byteLength(owned) > 103) throw new Error('Socket directory path is too long.');
  const link = owned + '.link';
  let previous;
  try { previous = await readlink(socket); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous && !/^\.endpoint-[0-9a-f-]{36}$/.test(previous))
    throw new Error('Existing socket link belongs to another application.');
  try {
    await listenServer(server, owned);
    await chmod(owned, 0o600);
    await symlink(name, link);
    await rename(link, socket);
  } catch (error) {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(link, { force: true });
    throw error;
  }
  if (previous) await rm(path.join(parent, previous), { force: true });
  return server;
}
