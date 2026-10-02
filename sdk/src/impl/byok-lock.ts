import { promises as fs } from 'node:fs'
import { createServer } from 'node:net'

function ownerIsDead(owner: string): boolean {
  if (!/^[1-9]\d*$/.test(owner)) return false
  const pid = Number(owner)
  if (!Number.isSafeInteger(pid) || pid > 0x7fffffff) return false
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    // EPERM (including another user's process) is not evidence of death.
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

async function readOwner(lock: string): Promise<string | undefined> {
  try {
    return await fs.readFile(lock, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Recover PID locks without allowing two reapers to unlink a successor's lock. */
export async function recoverByokLock(lock: string): Promise<void> {
  const owner = await readOwner(lock)
  if (owner === undefined || !ownerIsDead(owner)) return

  // A second filesystem lock would itself survive a crash. A loopback listener
  // is a short-lived, kernel-released reaper mutex on every supported OS. Key it
  // by the observed PID, so aliases of the configuration path share the mutex.
  // Collisions only defer recovery; they never allow concurrent reapers.
  const server = createServer((socket) => socket.destroy())
  const acquired = await new Promise<boolean>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') resolve(false)
      else reject(error)
    })
    server.listen(
      {
        host: '127.0.0.1',
        port: 49152 + (Number(owner) % 16384),
        exclusive: true,
      },
      () => resolve(true),
    )
  })
  if (!acquired) return
  try {
    // Re-read under the mutex: another reaper may already have removed the old
    // lock and a writer may now own the pathname. Never expire a live PID by age.
    if ((await readOwner(lock)) === owner && ownerIsDead(owner)) {
      await fs.unlink(lock).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
}
