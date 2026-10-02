import { afterEach, expect, test } from 'bun:test'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  createBunByokConnectionStore,
  createBunByokMetadataStore,
} from '../../byok'
import { recoverByokLock } from '../byok-lock'

const directories: string[] = []
const children: ReturnType<typeof spawn>[] = []
const modulePath = path.resolve(import.meta.dir, '../../byok.ts')

function spawn(code: string) {
  return Bun.spawn([process.execPath, '-e', code], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill('SIGKILL')
    await child.exited
  }
  for (const directory of directories.splice(0))
    await fs.rm(directory, { recursive: true, force: true })
})

async function fixture() {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'byok-lock-'))
  directories.push(directory)
  return { directory, lock: path.join(directory, 'connections.lock') }
}

async function holder(directory: string) {
  const child = spawn(`
    import { createBunByokMetadataStore } from ${JSON.stringify(modulePath)};
    await createBunByokMetadataStore({ directory: ${JSON.stringify(directory)} }).withLock(async () => {
      console.log('locked');
      await new Promise(() => setInterval(() => {}, 1000));
    });
  `)
  children.push(child)
  const reader = child.stdout.getReader()
  try {
    const result = await Promise.race([
      reader.read(),
      child.exited.then(async (code) => {
        throw new Error(
          `Lock holder exited ${code}: ${await new Response(child.stderr).text()}`,
        )
      }),
    ])
    expect(new TextDecoder().decode(result.value)).toContain('locked')
  } finally {
    reader.releaseLock()
  }
  return child
}

test('a crashed writer no longer prevents deleting a saved connection', async () => {
  const { directory, lock } = await fixture()
  const store = createBunByokConnectionStore({ directory, environment: {} })
  const connection = await store.create({
    name: 'Crash fixture',
    provider: 'openrouter',
    model: 'fixture-model',
    credentialRef: 'env:FIXTURE_KEY',
  })
  const child = await holder(directory)
  expect(await fs.readFile(lock, 'utf8')).toBe(String(child.pid))
  child.kill('SIGKILL')
  await child.exited
  await store.remove(connection)
  expect(await store.list()).toEqual([])
  expect(await fs.readdir(directory)).toEqual(['connections.json'])
}, 20_000)

test('recovery preserves a live owner even when its lock is old', async () => {
  const { directory, lock } = await fixture()
  const child = await holder(directory)
  await fs.utimes(lock, new Date(0), new Date(0))
  await Promise.all(Array.from({ length: 8 }, () => recoverByokLock(lock)))
  expect(await fs.readFile(lock, 'utf8')).toBe(String(child.pid))
}, 20_000)

test.each(['', 'broken', '-1', '0', '999999999999999999999'])(
  'recovery preserves unknown owner %j',
  async (owner) => {
    const { lock } = await fixture()
    await fs.writeFile(lock, owner)
    await recoverByokLock(lock)
    expect(await fs.readFile(lock, 'utf8')).toBe(owner)
  },
)

test('competing processes recover a legacy PID lock without losing writes', async () => {
  const { directory, lock } = await fixture()
  const dead = spawn('process.exit(0)')
  children.push(dead)
  await dead.exited
  // Exactly the format left by releases that used open("wx") + writeFile(pid).
  await fs.writeFile(lock, String(dead.pid))
  const counter = path.join(directory, 'counter')
  await fs.writeFile(counter, '0')
  const workers = Array.from({ length: 8 }, () => {
    const worker = spawn(`
      import { promises as fs } from 'node:fs';
      import { createBunByokMetadataStore } from ${JSON.stringify(modulePath)};
      const store = createBunByokMetadataStore({ directory: ${JSON.stringify(directory)} });
      for (let i = 0; i < 5; i++) await store.withLock(async () => {
        const value = Number(await fs.readFile(${JSON.stringify(counter)}, 'utf8'));
        await new Promise(resolve => setTimeout(resolve, 2));
        await fs.writeFile(${JSON.stringify(counter)}, String(value + 1));
      });
    `)
    children.push(worker)
    return worker
  })
  await Promise.all(
    workers.map(async (worker) => {
      const stderr = new Response(worker.stderr).text()
      expect({ code: await worker.exited, stderr: await stderr }).toEqual({
        code: 0,
        stderr: '',
      })
    }),
  )
  expect(await fs.readFile(counter, 'utf8')).toBe('40')
  expect((await fs.readdir(directory)).sort()).toEqual(['counter'])
}, 20_000)

test('throwing from an operation releases its lock for the next writer', async () => {
  const { directory } = await fixture()
  const store = createBunByokMetadataStore({ directory })
  await expect(
    store.withLock!(async () => {
      throw new Error('failed write')
    }),
  ).rejects.toThrow('failed write')
  expect(await store.withLock!(async () => 'next writer')).toBe('next writer')
  expect(await fs.readdir(directory)).toEqual([])
})
