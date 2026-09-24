import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  createSponsoredRootedFileSystem,
  probeSponsoredFileLayer,
  sponsoredDirectoryPinning,
} from '../tools/sponsored-rooted-filesystem'
import { sponsoredWindowsSegmentRefusal } from '../tools/sponsored-windows-paths'

import type { TerminalCommandBroker } from '../tools/run-terminal-command'

/**
 * The sponsored file layer, with no shell and no broker (COD-642).
 *
 * It used to run each operation as `/bin/sh` inside the OS broker, so the
 * kernel sandbox bounded whatever a race made it touch. It now runs in the
 * host process, so every race below has to be refused by the file layer
 * itself. The races are staged through the `raceWindow` seam, which runs in
 * the two windows a concurrent swap would use: after the lexical and realpath
 * checks passed (`checked`), and after each directory on the way is held open
 * (`pinned`).
 *
 * Runs on macOS and Linux in the ordinary matrix and in
 * `test-sponsored-containment-linux`, and on Windows in `smoke-windows-bash`
 * — where there is no `/bin/sh` at all, which is what a file-only procedure
 * failing there was about.
 */

const isWindows = process.platform === 'win32'

let parent: string
let root: string
let outside: string

beforeEach(() => {
  parent = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'sponsored-rooted-fs-')),
  )
  root = path.join(parent, 'worktree')
  outside = path.join(parent, 'outside')
  fs.mkdirSync(root, { recursive: true })
  fs.mkdirSync(outside, { recursive: true })
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside-secret')
})

afterEach(() => {
  fs.rmSync(parent, { recursive: true, force: true })
})

/** A directory link that works unprivileged on every OS (a junction on Windows). */
function linkDirectory(target: string, link: string): void {
  fs.symlinkSync(target, link, isWindows ? 'junction' : 'dir')
}

/** Replace a directory with a link to `target`, as a racing command would. */
function swapForLink(directory: string, target: string): void {
  fs.renameSync(directory, `${directory}-original`)
  linkDirectory(target, directory)
}

/** Run `swap` once, in the window right after the path checks passed. */
function onChecked(swap: () => void) {
  let done = false
  return (phase: 'checked' | 'pinned') => {
    if (done || phase !== 'checked') return
    done = true
    swap()
  }
}

/** A broker that fails the test if the file layer ever starts a process. */
function forbiddenBroker(): TerminalCommandBroker & { starts: number } {
  const broker = {
    starts: 0,
    start() {
      broker.starts++
      throw new Error('the sponsored file layer must not start a process')
    },
  }
  return broker
}

describe('sponsored rooted filesystem: no shell, every OS', () => {
  test('pins directories with a kernel mechanism on every supported OS, and refuses the rest', () => {
    expect(sponsoredDirectoryPinning('linux')).toBe('proc-fd')
    expect(sponsoredDirectoryPinning('darwin')).toBe('volfs')
    expect(sponsoredDirectoryPinning('win32')).toBe('lstat')
    expect(sponsoredDirectoryPinning('freebsd')).toBeNull()
  })

  test('a file-only procedure succeeds without starting any process', async () => {
    const broker = forbiddenBroker()
    const rooted = createSponsoredRootedFileSystem({
      workspaceRoot: root,
      // Deprecated and ignored; passed here to prove it is never started.
      processBroker: broker,
    })
    await rooted.mkdir(path.join(root, 'src', 'lib'), { recursive: true })
    await rooted.writeFile(path.join(root, 'src', 'lib', 'a.ts'), 'one\n')
    await rooted.writeFile(path.join(root, 'src', 'lib', 'a.ts'), 'two\n')
    await rooted.writeFile(
      path.join(root, 'src', 'b.ts'),
      new TextEncoder().encode('bytes\n'),
    )
    expect(
      await rooted.readFile(path.join(root, 'src', 'lib', 'a.ts'), 'utf8'),
    ).toBe('two\n')
    expect(
      Buffer.from(
        await rooted.readFile(path.join(root, 'src', 'b.ts')),
      ).toString(),
    ).toBe('bytes\n')
    expect((await rooted.readdir(path.join(root, 'src'))).sort()).toEqual([
      'b.ts',
      'lib',
    ])
    const typed = (await rooted.readdir(path.join(root, 'src'), {
      withFileTypes: true,
    })) as unknown as Array<{
      name: string
      isDirectory(): boolean
      isFile(): boolean
    }>
    expect(
      typed
        .map((entry) => [entry.name, entry.isDirectory(), entry.isFile()])
        .sort(),
    ).toEqual([
      ['b.ts', false, true],
      ['lib', true, false],
    ])
    const stat = await rooted.stat(path.join(root, 'src', 'lib', 'a.ts'))
    expect(stat.isFile()).toBe(true)
    expect(stat.size).toBe(4)
    expect((await rooted.stat(root)).isDirectory()).toBe(true)
    expect((await rooted.stat(path.join(root, 'src'))).isDirectory()).toBe(true)
    await rooted.unlink(path.join(root, 'src', 'b.ts'))
    expect(fs.existsSync(path.join(root, 'src', 'b.ts'))).toBe(false)
    // Relative paths resolve against the worktree, as they always did.
    await rooted.writeFile('relative.txt', 'rel')
    expect(fs.readFileSync(path.join(root, 'relative.txt'), 'utf8')).toBe('rel')
    expect(broker.starts).toBe(0)
  })

  test('the module imports no process API at all', () => {
    // The functional test above cannot see a spawn that happens to succeed.
    // This can: a shell dependency starts with an import.
    const source = fs.readFileSync(
      path.join(
        import.meta.dir,
        '..',
        'tools',
        'sponsored-rooted-filesystem.ts',
      ),
      'utf8',
    )
    expect(source).not.toMatch(/from ['"](node:)?child_process['"]/)
    expect(source).not.toMatch(/require\(['"](node:)?child_process['"]\)/)
    expect(source).not.toMatch(/\bBun\.spawn/)
    expect(source).not.toMatch(/\.start\(/)
  })

  test('mkdir is recursive unless told otherwise, and a missing leaf is ENOENT', async () => {
    const rooted = createSponsoredRootedFileSystem({ workspaceRoot: root })
    await rooted.mkdir(path.join(root, 'a', 'b'))
    expect(fs.statSync(path.join(root, 'a', 'b')).isDirectory()).toBe(true)
    await expect(
      rooted.mkdir(path.join(root, 'a', 'b'), { recursive: false }),
    ).rejects.toMatchObject({ code: 'EEXIST' })
    await expect(
      rooted.readFile(path.join(root, 'missing.ts'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      rooted.stat(path.join(root, 'missing.ts')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('sponsored rooted filesystem: writes outside the worktree are refused', () => {
  test('by absolute path, by `..`, and by `~`', async () => {
    const rooted = createSponsoredRootedFileSystem({ workspaceRoot: root })
    for (const requested of [
      path.join(outside, 'escaped.txt'),
      path.join('..', 'outside', 'escaped.txt'),
      path.join(root, '..', 'outside', 'escaped.txt'),
      path.join('src', '..', '..', 'outside', 'escaped.txt'),
    ]) {
      await expect(
        rooted.writeFile(requested, 'escaped'),
        requested,
      ).rejects.toThrow(/inside its own worktree/)
      await expect(rooted.mkdir(requested), requested).rejects.toThrow(
        /inside its own worktree/,
      )
    }
    await expect(rooted.writeFile('~/escaped.txt', 'x')).rejects.toThrow(
      /worktree/,
    )
    await expect(
      rooted.unlink(path.join(outside, 'secret.txt')),
    ).rejects.toThrow(/inside its own worktree/)
    expect(fs.readdirSync(outside)).toEqual(['secret.txt'])
    expect(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8')).toBe(
      'outside-secret',
    )
  })

  test('through a directory link that already points out of the worktree', async () => {
    linkDirectory(outside, path.join(root, 'escape'))
    const rooted = createSponsoredRootedFileSystem({ workspaceRoot: root })
    await expect(
      rooted.writeFile(path.join(root, 'escape', 'escaped.txt'), 'escaped'),
    ).rejects.toThrow(/symlink/)
    await expect(
      rooted.writeFile(path.join(root, 'escape', 'secret.txt'), 'overwritten'),
    ).rejects.toThrow(/symlink/)
    await expect(
      rooted.mkdir(path.join(root, 'escape', 'made')),
    ).rejects.toThrow(/symlink/)
    await expect(
      rooted.unlink(path.join(root, 'escape', 'secret.txt')),
    ).rejects.toThrow(/symlink/)
    await expect(
      rooted.readFile(path.join(root, 'escape', 'secret.txt'), 'utf8'),
    ).rejects.toThrow(/symlink/)
    await expect(rooted.readdir(path.join(root, 'escape'))).rejects.toThrow(
      /symlink/,
    )
    expect(fs.readdirSync(outside)).toEqual(['secret.txt'])
    expect(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8')).toBe(
      'outside-secret',
    )
  })

  test.skipIf(isWindows)(
    'through a file symlink, including a dangling one',
    async () => {
      fs.symlinkSync(
        path.join(outside, 'secret.txt'),
        path.join(root, 'linked.txt'),
      )
      fs.symlinkSync(
        path.join(outside, 'created-by-write.txt'),
        path.join(root, 'dangling.txt'),
      )
      const rooted = createSponsoredRootedFileSystem({ workspaceRoot: root })
      await expect(
        rooted.writeFile(path.join(root, 'linked.txt'), 'overwritten'),
      ).rejects.toThrow(/symlink/)
      await expect(
        rooted.writeFile(path.join(root, 'dangling.txt'), 'created'),
      ).rejects.toThrow(/symlink|could not safely resolve/)
      await expect(
        rooted.readFile(path.join(root, 'linked.txt'), 'utf8'),
      ).rejects.toThrow(/symlink/)
      expect(fs.existsSync(path.join(outside, 'created-by-write.txt'))).toBe(
        false,
      )
      expect(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8')).toBe(
        'outside-secret',
      )
    },
  )

  test('through a hard link to a file outside the worktree', async () => {
    // The sandboxed shell cannot make this link (seatbelt refuses `ln` of an
    // outside file; bubblewrap never mounts one). But the file layer is NOT
    // sandboxed any more, so it must not be the thing that writes through
    // one if it ever exists. It never opens the target at all: the write is
    // staged beside it and renamed over the NAME, so the other name keeps the
    // bytes it had.
    fs.linkSync(path.join(outside, 'secret.txt'), path.join(root, 'hard.txt'))
    const rooted = createSponsoredRootedFileSystem({ workspaceRoot: root })
    await rooted.writeFile(path.join(root, 'hard.txt'), 'replaced')
    expect(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8')).toBe(
      'outside-secret',
    )
    expect(fs.readFileSync(path.join(root, 'hard.txt'), 'utf8')).toBe(
      'replaced',
    )
    expect(fs.statSync(path.join(root, 'hard.txt')).nlink).toBe(1)
  })

  test('to the classes the surface refuses, including through an alias', async () => {
    fs.mkdirSync(path.join(root, '.git', 'hooks'), { recursive: true })
    fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    // A link INSIDE the worktree to `.git`: the surface's lexical class check
    // sees `docs/hooks/pre-commit`, which is not a git path by spelling.
    linkDirectory(path.join(root, '.git'), path.join(root, 'docs'))
    const rooted = createSponsoredRootedFileSystem({ workspaceRoot: root })
    for (const requested of [
      path.join(root, '.git', 'hooks', 'pre-commit'),
      path.join(root, 'docs', 'hooks', 'pre-commit'),
      path.join(root, '.github', 'workflows', 'ci.yml'),
      path.join(root, '.npmrc'),
    ]) {
      await expect(
        rooted.writeFile(requested, '#!/bin/sh\necho pwned\n'),
        requested,
      ).rejects.toThrow(/Refusing/)
    }
    await expect(
      rooted.mkdir(path.join(root, 'docs', 'hooks', 'pre-commit.d')),
    ).rejects.toThrow(/Refusing/)
    await expect(
      rooted.unlink(path.join(root, 'docs', 'HEAD')),
    ).rejects.toThrow(/Refusing/)
    expect(fs.existsSync(path.join(root, '.git', 'HEAD'))).toBe(true)
    expect(fs.readdirSync(path.join(root, '.git', 'hooks'))).toEqual([])
    expect(fs.existsSync(path.join(root, '.github'))).toBe(false)
    expect(fs.existsSync(path.join(root, '.npmrc'))).toBe(false)
  })
})

describe('sponsored rooted filesystem: a swap after the path check', () => {
  const swapAfterCheck =
    (directory: string, target = outside) =>
    () => {
      swapForLink(directory, target)
    }

  test('never reaches a host destination write', async () => {
    fs.mkdirSync(path.join(root, 'late'))
    const rooted = createSponsoredRootedFileSystem({
      workspaceRoot: root,
      raceWindow: onChecked(swapAfterCheck(path.join(root, 'late'))),
    })
    await expect(
      rooted.writeFile(path.join(root, 'late', 'escaped.ts'), 'escaped'),
    ).rejects.toThrow(/symlink/)
    expect(fs.readdirSync(outside)).toEqual(['secret.txt'])
  })

  test('cannot overwrite an outside file by swapping its parent', async () => {
    fs.mkdirSync(path.join(root, 'late'))
    fs.writeFileSync(path.join(root, 'late', 'secret.txt'), 'inside')
    const rooted = createSponsoredRootedFileSystem({
      workspaceRoot: root,
      raceWindow: onChecked(swapAfterCheck(path.join(root, 'late'))),
    })
    await expect(
      rooted.writeFile(path.join(root, 'late', 'secret.txt'), 'overwritten'),
    ).rejects.toThrow(/symlink/)
    expect(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8')).toBe(
      'outside-secret',
    )
  })

  test('cannot create a directory outside', async () => {
    fs.mkdirSync(path.join(root, 'late'))
    const rooted = createSponsoredRootedFileSystem({
      workspaceRoot: root,
      raceWindow: onChecked(swapAfterCheck(path.join(root, 'late'))),
    })
    await expect(rooted.mkdir(path.join(root, 'late', 'made'))).rejects.toThrow(
      /symlink/,
    )
    expect(fs.readdirSync(outside)).toEqual(['secret.txt'])
  })

  test('cannot remove an outside file', async () => {
    fs.mkdirSync(path.join(root, 'late'))
    fs.writeFileSync(path.join(root, 'late', 'secret.txt'), 'inside')
    const rooted = createSponsoredRootedFileSystem({
      workspaceRoot: root,
      raceWindow: onChecked(swapAfterCheck(path.join(root, 'late'))),
    })
    await expect(
      rooted.unlink(path.join(root, 'late', 'secret.txt')),
    ).rejects.toThrow(/symlink/)
    expect(fs.existsSync(path.join(outside, 'secret.txt'))).toBe(true)
  })

  test('cannot read outside content', async () => {
    const readParent = path.join(root, 'late')
    fs.mkdirSync(readParent)
    fs.writeFileSync(path.join(readParent, 'secret.txt'), 'inside')
    const rooted = createSponsoredRootedFileSystem({
      workspaceRoot: root,
      raceWindow: onChecked(swapAfterCheck(readParent)),
    })
    const read = rooted.readFile(path.join(readParent, 'secret.txt'), 'utf8')
    await expect(read).rejects.toThrow(/symlink/)
  })

  test('cannot list outside names', async () => {
    const listed = path.join(root, 'late')
    fs.mkdirSync(listed)
    const rooted = createSponsoredRootedFileSystem({
      workspaceRoot: root,
      raceWindow: onChecked(swapAfterCheck(listed)),
    })
    await expect(rooted.readdir(listed)).rejects.toThrow(/symlink/)
  })

  test('cannot stat an outside file', async () => {
    fs.mkdirSync(path.join(root, 'late'))
    fs.writeFileSync(path.join(root, 'late', 'secret.txt'), 'inside')
    const rooted = createSponsoredRootedFileSystem({
      workspaceRoot: root,
      raceWindow: onChecked(swapAfterCheck(path.join(root, 'late'))),
    })
    await expect(
      rooted.stat(path.join(root, 'late', 'secret.txt')),
    ).rejects.toThrow(/symlink/)
  })

  test('a deeper ancestor swap is refused too', async () => {
    fs.mkdirSync(path.join(root, 'a', 'b', 'c'), { recursive: true })
    fs.mkdirSync(path.join(outside, 'b', 'c'), { recursive: true })
    const rooted = createSponsoredRootedFileSystem({
      workspaceRoot: root,
      raceWindow: onChecked(swapAfterCheck(path.join(root, 'a'))),
    })
    await expect(
      rooted.writeFile(path.join(root, 'a', 'b', 'c', 'x.ts'), 'escaped'),
    ).rejects.toThrow(/symlink/)
    expect(fs.readdirSync(path.join(outside, 'b', 'c'))).toEqual([])
  })

  test.skipIf(isWindows)(
    'a leaf swapped for a symlink after the check is refused, not followed',
    async () => {
      const leaf = path.join(root, 'target.txt')
      fs.writeFileSync(leaf, 'inside')
      const swapLeaf = () => {
        fs.rmSync(leaf)
        fs.symlinkSync(path.join(outside, 'secret.txt'), leaf)
      }
      const reader = createSponsoredRootedFileSystem({
        workspaceRoot: root,
        raceWindow: onChecked(swapLeaf),
      })
      await expect(reader.readFile(leaf, 'utf8')).rejects.toThrow(/symlink/)

      fs.rmSync(leaf)
      fs.writeFileSync(leaf, 'inside')
      const writer = createSponsoredRootedFileSystem({
        workspaceRoot: root,
        raceWindow: onChecked(swapLeaf),
      })
      await expect(writer.writeFile(leaf, 'overwritten')).rejects.toThrow(
        /symlink/,
      )
      expect(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8')).toBe(
        'outside-secret',
      )
    },
  )

  test('a guarded directory replaced by a file cannot continue in the wrong ancestor', async () => {
    const guarded = path.join(root, 'late')
    fs.mkdirSync(guarded, { recursive: true })
    const rooted = createSponsoredRootedFileSystem({
      workspaceRoot: root,
      raceWindow: onChecked(() => {
        fs.renameSync(guarded, path.join(root, 'original-directory'))
        fs.writeFileSync(guarded, 'now a file')
      }),
    })
    await expect(
      rooted.writeFile(path.join(guarded, 'escaped.ts'), 'escaped'),
    ).rejects.toMatchObject({ code: 'ENOTDIR' })
    expect(fs.existsSync(path.join(root, 'escaped.ts'))).toBe(false)
  })
})

/**
 * The race the pin exists for: a directory swapped AFTER the walk has already
 * passed through it. A lexical, realpath or `lstat` check cannot see this at
 * all — every one of them ran before the swap — so the only thing between the
 * operation and the link is that it resolves inside the directory the walk
 * HOLDS, not inside whatever the pathname names now. Before COD-642 the OS
 * sandbox bounded this; now `/proc/self/fd` (Linux) and `/.vol` (macOS) do.
 *
 * Skipped on Windows, where Node exposes no handle-relative open; see
 * `docs/freebuff-sponsored-local-execution.md`, "The file layer without a
 * shell (COD-642)".
 */
describe('sponsored rooted filesystem: a swap after the directory is pinned', () => {
  const pinnedIt = test.skipIf(isWindows)

  /** Swap `directory` for a link the moment the walk has pinned it. */
  const swapOncePinned = (directory: string) => {
    let swapped = false
    return (phase: 'checked' | 'pinned', pinned: string) => {
      if (swapped || phase !== 'pinned' || pinned !== directory) return
      swapped = true
      swapForLink(directory, outside)
    }
  }

  pinnedIt(
    'a write lands in the directory that was pinned, never through the link',
    async () => {
      const late = path.join(root, 'late')
      fs.mkdirSync(late)
      const rooted = createSponsoredRootedFileSystem({
        workspaceRoot: root,
        raceWindow: swapOncePinned(late),
      })
      await rooted.writeFile(path.join(late, 'written.ts'), 'written')
      expect(fs.readdirSync(outside)).toEqual(['secret.txt'])
      expect(
        fs.readFileSync(path.join(`${late}-original`, 'written.ts'), 'utf8'),
      ).toBe('written')
    },
  )

  pinnedIt(
    'a read comes from the pinned directory, never through the link',
    async () => {
      const late = path.join(root, 'late')
      fs.mkdirSync(late)
      fs.writeFileSync(path.join(late, 'secret.txt'), 'inside')
      const rooted = createSponsoredRootedFileSystem({
        workspaceRoot: root,
        raceWindow: swapOncePinned(late),
      })
      expect(await rooted.readFile(path.join(late, 'secret.txt'), 'utf8')).toBe(
        'inside',
      )
    },
  )

  pinnedIt(
    'a listing is of the pinned directory, never through the link',
    async () => {
      const late = path.join(root, 'late')
      fs.mkdirSync(late)
      fs.writeFileSync(path.join(late, 'inside.ts'), 'inside')
      const rooted = createSponsoredRootedFileSystem({
        workspaceRoot: root,
        raceWindow: swapOncePinned(late),
      })
      expect(await rooted.readdir(late)).toEqual(['inside.ts'])
    },
  )

  pinnedIt(
    'a removal is in the pinned directory, never through the link',
    async () => {
      const late = path.join(root, 'late')
      fs.mkdirSync(late)
      fs.writeFileSync(path.join(late, 'secret.txt'), 'inside')
      const rooted = createSponsoredRootedFileSystem({
        workspaceRoot: root,
        raceWindow: swapOncePinned(late),
      })
      await rooted.unlink(path.join(late, 'secret.txt'))
      expect(fs.existsSync(path.join(outside, 'secret.txt'))).toBe(true)
      expect(fs.existsSync(path.join(`${late}-original`, 'secret.txt'))).toBe(
        false,
      )
    },
  )

  pinnedIt(
    'a directory created mid-walk is created in the pinned parent',
    async () => {
      const late = path.join(root, 'late')
      fs.mkdirSync(late)
      const rooted = createSponsoredRootedFileSystem({
        workspaceRoot: root,
        raceWindow: swapOncePinned(late),
      })
      await rooted.mkdir(path.join(late, 'made', 'deeper'))
      expect(fs.readdirSync(outside)).toEqual(['secret.txt'])
      expect(
        fs
          .statSync(path.join(`${late}-original`, 'made', 'deeper'))
          .isDirectory(),
      ).toBe(true)
    },
  )
})

describe('sponsored rooted filesystem: what it will not open', () => {
  test.skipIf(isWindows)(
    'a FIFO in the worktree is refused instead of blocking the read',
    async () => {
      const fifo = path.join(root, 'pipe')
      const made = spawnSync('mkfifo', [fifo])
      if (made.status !== 0) return
      const rooted = createSponsoredRootedFileSystem({ workspaceRoot: root })
      await expect(rooted.readFile(fifo, 'utf8')).rejects.toThrow(
        /regular files/,
      )
    },
  )

  test('a directory cannot be read or overwritten as a file', async () => {
    fs.mkdirSync(path.join(root, 'dir'))
    const rooted = createSponsoredRootedFileSystem({ workspaceRoot: root })
    await expect(
      rooted.readFile(path.join(root, 'dir'), 'utf8'),
    ).rejects.toMatchObject({ code: 'EISDIR' })
    await expect(
      rooted.writeFile(path.join(root, 'dir'), 'x'),
    ).rejects.toThrow()
    expect(fs.statSync(path.join(root, 'dir')).isDirectory()).toBe(true)
  })

  test('the worktree root cannot be removed or replaced', async () => {
    const rooted = createSponsoredRootedFileSystem({ workspaceRoot: root })
    await expect(rooted.unlink(root)).rejects.toThrow(/worktree root/)
    await expect(rooted.writeFile(root, 'x')).rejects.toThrow(/worktree root/)
  })

  test('refuses anything but a replacing write', async () => {
    const rooted = createSponsoredRootedFileSystem({ workspaceRoot: root })
    await expect(
      rooted.writeFile(path.join(root, 'a.txt'), 'x', { flag: 'a' }),
    ).rejects.toThrow(/only support replacing/)
  })
})

/** Anything a write staged and failed to clean up, anywhere in the worktree. */
function stagedLeftovers(directory: string): string[] {
  const found: string[] = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name)
    if (entry.name.startsWith('.sponsored-write-')) found.push(full)
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      found.push(...stagedLeftovers(full))
    }
  }
  return found
}

describe('sponsored rooted filesystem: writes are atomic', () => {
  test('a write replaces the file and leaves nothing staged', async () => {
    const rooted = createSponsoredRootedFileSystem({ workspaceRoot: root })
    const target = path.join(root, 'src', 'a.ts')
    await rooted.writeFile(target, 'first\n')
    await rooted.writeFile(target, 'second, and longer than the first\n')
    await rooted.writeFile(target, 'third\n')
    expect(fs.readFileSync(target, 'utf8')).toBe('third\n')
    expect(stagedLeftovers(root)).toEqual([])
  })

  test('a refused write leaves nothing staged', async () => {
    fs.mkdirSync(path.join(root, 'dir'))
    const rooted = createSponsoredRootedFileSystem({ workspaceRoot: root })
    await expect(
      rooted.writeFile(path.join(root, 'dir'), 'x'),
    ).rejects.toMatchObject({ code: 'EISDIR' })
    expect(stagedLeftovers(root)).toEqual([])
  })

  test.skipIf(isWindows)(
    'a replaced file is a new inode that keeps its permission bits',
    async () => {
      const target = path.join(root, 'run.sh')
      fs.writeFileSync(target, '#!/bin/sh\necho old\n')
      fs.chmodSync(target, 0o755)
      const before = fs.statSync(target).ino
      const rooted = createSponsoredRootedFileSystem({ workspaceRoot: root })
      await rooted.writeFile(target, '#!/bin/sh\necho new\n')
      const after = fs.statSync(target)
      expect(after.ino).not.toBe(before)
      expect(after.mode & 0o777).toBe(0o755)
      expect(fs.readFileSync(target, 'utf8')).toContain('echo new')
    },
  )

  test.skipIf(isWindows)(
    'a FIFO is refused as a write target, not opened',
    async () => {
      const fifo = path.join(root, 'pipe')
      if (spawnSync('mkfifo', [fifo]).status !== 0) return
      const rooted = createSponsoredRootedFileSystem({ workspaceRoot: root })
      await expect(rooted.writeFile(fifo, 'x')).rejects.toThrow(/regular files/)
      expect(fs.lstatSync(fifo).isFIFO()).toBe(true)
    },
  )
})

describe('sponsored rooted filesystem: Windows spellings', () => {
  test('refuses every component Win32 would reinterpret, and nothing else', () => {
    for (const reinterpreted of [
      '.npmrc.',
      '.npmrc ',
      '.github.',
      '.github ',
      '.npmrc::$DATA',
      'package.json:hidden',
      'GITHUB~1',
      'PROGRA~12.TXT',
      '.HUSKY~1',
    ]) {
      expect(
        sponsoredWindowsSegmentRefusal(reinterpreted),
        reinterpreted,
      ).not.toBeNull()
    }
    for (const plain of [
      '.github',
      '.npmrc',
      'src',
      'a.b.c',
      'backup~',
      '~$report.docx',
      'file with spaces.ts',
    ]) {
      expect(sponsoredWindowsSegmentRefusal(plain), plain).toBeNull()
    }
  })

  test.skipIf(!isWindows)(
    'a spelling Windows would land on a refused class is refused before anything is written',
    async () => {
      fs.mkdirSync(path.join(root, '.github', 'workflows'), {
        recursive: true,
      })
      const rooted = createSponsoredRootedFileSystem({ workspaceRoot: root })
      for (const requested of [
        path.join(root, '.npmrc::$DATA'),
        path.join(root, '.npmrc.'),
        path.join(root, '.npmrc '),
        path.join(root, '.github.', 'workflows', 'ci.yml'),
        path.join(root, '.github ', 'workflows', 'ci.yml'),
        path.join(root, 'GITHUB~1', 'workflows', 'ci.yml'),
        path.join(root, '.husky.', 'pre-commit'),
      ]) {
        await expect(
          rooted.writeFile(requested, 'registry=https://evil.example\n'),
          requested,
        ).rejects.toThrow(/Windows|dot or a space/)
      }
      await expect(
        rooted.readFile(path.join(root, '.npmrc::$DATA'), 'utf8'),
      ).rejects.toThrow(/stream/)
      expect(fs.existsSync(path.join(root, '.npmrc'))).toBe(false)
      expect(fs.existsSync(path.join(root, '.husky'))).toBe(false)
      expect(fs.readdirSync(path.join(root, '.github', 'workflows'))).toEqual(
        [],
      )
    },
  )

  /**
   * A reparse point Node's `lstat` does NOT report as a link: a junction onto
   * a volume GUID path. libuv only reads a junction as a link when its target
   * is a drive-letter path, so this one looks like an ordinary directory while
   * the kernel follows it. Built with `mklink /J`; where the runner cannot
   * build one that both hides from `lstat` and reaches outside, the test says
   * so and asserts nothing, rather than passing on a fixture that proves
   * nothing.
   */
  test.skipIf(!isWindows)(
    'a reparse point lstat does not report as a link is still refused',
    async () => {
      const drive = path.parse(outside).root
      const volume = (
        spawnSync('mountvol', [drive, '/L'], { encoding: 'utf8' }).stdout ?? ''
      ).trim()
      if (!/^\\\\\?\\Volume\{[0-9a-fA-F-]+\}\\$/.test(volume)) {
        console.log(`PRECONDITION NOT MET: no volume GUID for ${drive}`)
        return
      }
      const link = path.join(root, 'mounted')
      const target = volume + outside.slice(drive.length)
      const made = spawnSync(
        'cmd.exe',
        ['/d', '/c', 'mklink', '/J', link, target],
        { encoding: 'utf8' },
      )
      try {
        if (made.status !== 0) {
          console.log(
            `PRECONDITION NOT MET: mklink /J to ${target}: ${made.stdout}${made.stderr}`,
          )
          return
        }
        if (
          fs.lstatSync(link).isSymbolicLink() ||
          !fs.existsSync(path.join(link, 'secret.txt'))
        ) {
          console.log(
            'PRECONDITION NOT MET: the junction is visible to lstat or does not reach outside',
          )
          return
        }
        console.log(
          'PRECONDITION MET: lstat reports a directory, the kernel reaches outside',
        )
        const rooted = createSponsoredRootedFileSystem({ workspaceRoot: root })
        // The REDIRECT refusal, not the plain symlink one: lstat saw nothing,
        // so only the native final-path check can have refused this.
        const refusal = /symlink, junction or mount point/
        await expect(
          rooted.readFile(path.join(link, 'secret.txt'), 'utf8'),
        ).rejects.toThrow(refusal)
        await expect(rooted.readdir(link)).rejects.toThrow(refusal)
        await expect(
          rooted.writeFile(path.join(link, 'secret.txt'), 'overwritten'),
        ).rejects.toThrow(refusal)
        await expect(
          rooted.writeFile(path.join(link, 'new.txt'), 'created'),
        ).rejects.toThrow(refusal)
        await expect(
          rooted.unlink(path.join(link, 'secret.txt')),
        ).rejects.toThrow(refusal)
        expect(fs.readdirSync(outside)).toEqual(['secret.txt'])
        expect(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8')).toBe(
          'outside-secret',
        )
      } finally {
        // Remove the junction itself, never what it points at.
        try {
          fs.rmdirSync(link)
        } catch {
          spawnSync('cmd.exe', ['/d', '/c', 'rmdir', link])
        }
      }
    },
  )
})

describe('sponsored rooted filesystem: availability probe', () => {
  test('says yes here, by proving the pin names the worktree', () => {
    expect(probeSponsoredFileLayer(root)).toEqual({
      available: true,
      pinning: sponsoredDirectoryPinning(process.platform)!,
    })
  })

  test('says no where there is no mechanism, or no worktree', () => {
    expect(probeSponsoredFileLayer(root, 'freebsd')).toEqual({
      available: false,
      reason: 'no-pin-mechanism',
    })
    expect(probeSponsoredFileLayer(path.join(root, 'missing'))).toEqual({
      available: false,
      reason: 'worktree-unreadable',
    })
  })
})
