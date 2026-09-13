import { mock } from 'bun:test'

import type { CodebuffFileSystem } from '../../types/filesystem'
import type { Mock } from 'bun:test'
import type { PathLike, Stats } from 'node:fs'

export interface CreateMockFsOptions {
  files?: Record<string, string>
  directories?: Record<string, string[]>
  readFileImpl?: (path: string) => Promise<string>
  readdirImpl?: (path: string) => Promise<string[]>
  writeFileImpl?: (path: string, content: string) => Promise<void>
  mkdirImpl?: (
    path: string,
    options?: { recursive?: boolean },
  ) => Promise<string | undefined>
  realpathImpl?: (path: string) => Promise<string>
  statImpl?: (path: string) => Promise<Stats>
}

export interface MockFs extends CodebuffFileSystem {}

export interface MockFsWithMocks {
  readFile: Mock<
    (path: PathLike, options?: { encoding?: BufferEncoding }) => Promise<string>
  >
  readdir: Mock<(path: PathLike) => Promise<string[]>>
  writeFile: Mock<(path: PathLike, data: string) => Promise<void>>
  mkdir: Mock<
    (
      path: PathLike,
      options?: { recursive?: boolean },
    ) => Promise<string | undefined>
  >
  realpath: Mock<(path: PathLike) => Promise<string>>
  stat: Mock<(path: PathLike) => Promise<Stats>>
}

/** Creates a mock filesystem compatible with CodebuffFileSystem. */
export function createMockFs(options: CreateMockFsOptions = {}): MockFs {
  const {
    files = {},
    directories = {},
    readFileImpl,
    readdirImpl,
    writeFileImpl,
    mkdirImpl,
    realpathImpl,
    statImpl,
  } = options

  const writtenFiles: Record<string, string> = { ...files }
  const createdDirs: Set<string> = new Set(Object.keys(directories))

  const defaultReadFile = async (path: PathLike): Promise<string> => {
    const pathStr = String(path)
    if (pathStr in writtenFiles) {
      return writtenFiles[pathStr]
    }
    throw new Error(`File not found: ${pathStr}`)
  }

  const defaultReaddir = async (path: PathLike): Promise<string[]> => {
    const pathStr = String(path)
    if (pathStr in directories) {
      return directories[pathStr]
    }
    throw new Error(`Directory not found: ${pathStr}`)
  }

  const defaultWriteFile = async (
    path: PathLike,
    data: string,
  ): Promise<void> => {
    const pathStr = String(path)
    writtenFiles[pathStr] = data
  }

  const defaultMkdir = async (path: PathLike): Promise<string | undefined> => {
    const pathStr = String(path)
    createdDirs.add(pathStr)
    return undefined
  }

  const defaultRealpath = async (path: PathLike): Promise<string> => {
    const pathStr = String(path)
    const isKnownPath =
      pathStr in writtenFiles ||
      pathStr in directories ||
      createdDirs.has(pathStr)

    if (!isKnownPath) {
      throw new Error(`Path not found: ${pathStr}`)
    }

    return pathStr
  }

  const defaultStat = async (path: PathLike): Promise<Stats> => {
    const pathStr = String(path)
    const isFile = pathStr in writtenFiles
    const isDir = pathStr in directories || createdDirs.has(pathStr)

    if (!isFile && !isDir) {
      throw new Error(`Path not found: ${pathStr}`)
    }

    return {
      isFile: () => isFile,
      isDirectory: () => isDir,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isSymbolicLink: () => false,
      isFIFO: () => false,
      isSocket: () => false,
      dev: 0,
      ino: 0,
      mode: isDir ? 0o755 : 0o644,
      nlink: 1,
      uid: 0,
      gid: 0,
      rdev: 0,
      size: isFile ? writtenFiles[pathStr].length : 0,
      blksize: 4096,
      blocks: 0,
      atimeMs: Date.now(),
      mtimeMs: Date.now(),
      ctimeMs: Date.now(),
      birthtimeMs: Date.now(),
      atime: new Date(),
      mtime: new Date(),
      ctime: new Date(),
      birthtime: new Date(),
    } as Stats
  }

  const readFileFn = readFileImpl
    ? async (path: PathLike) => readFileImpl(String(path))
    : defaultReadFile

  const readdirFn = readdirImpl
    ? async (path: PathLike) => readdirImpl(String(path))
    : defaultReaddir

  const writeFileFn = writeFileImpl
    ? async (path: PathLike, data: string) => writeFileImpl(String(path), data)
    : defaultWriteFile

  const mkdirFn = mkdirImpl
    ? async (path: PathLike, opts?: { recursive?: boolean }) =>
        mkdirImpl(String(path), opts)
    : defaultMkdir

  const realpathFn = realpathImpl
    ? async (path: PathLike) => realpathImpl(String(path))
    : defaultRealpath

  const statFn = statImpl
    ? async (path: PathLike) => statImpl(String(path))
    : defaultStat

  return {
    readFile: mock(readFileFn),
    readdir: mock(readdirFn),
    writeFile: mock(writeFileFn),
    mkdir: mock(mkdirFn),
    realpath: mock(realpathFn),
    stat: mock(statFn),
  } as unknown as MockFs
}

export function restoreMockFs(mockFs: MockFs): void {
  const mocks = mockFs as unknown as MockFsWithMocks
  mocks.readFile.mockRestore()
  mocks.readdir.mockRestore()
  mocks.writeFile.mockRestore()
  mocks.mkdir.mockRestore()
  mocks.realpath.mockRestore()
  mocks.stat.mockRestore()
}

export function clearMockFs(mockFs: MockFs): void {
  const mocks = mockFs as unknown as MockFsWithMocks
  mocks.readFile.mockClear()
  mocks.readdir.mockClear()
  mocks.writeFile.mockClear()
  mocks.mkdir.mockClear()
  mocks.realpath.mockClear()
  mocks.stat.mockClear()
}
