#!/usr/bin/env node

const { spawn } = require('child_process')
const fs = require('fs')
const http = require('http')
const https = require('https')
const os = require('os')
const path = require('path')
const { pipeline } = require('stream/promises')
const zlib = require('zlib')

const tar = require('tar')
const { createReleaseHttpClient } = require('./http')

function createLauncher(productConfig) {
  const {
    packageName,
    displayName,
    wrapperVersion = null,
    includeTreeSitterWasm = true,
    startupBanner = [],
    telemetryEvent = 'cli.update_codebuff_failed',
    telemetryProperties = {},
    tempDownloadDirName = `.${packageName}-download-temp`,
    // Tests only. os.homedir() ignores $HOME under `bun test`, so pointing HOME
    // at a temp dir is not enough to keep a test off the real ~/.config.
    configDir: configDirOverride = null,
  } = productConfig

  /**
   * Terminal escape sequences to reset terminal state after the child process exits.
   * When the binary is SIGKILL'd, it can't clean up its own terminal state.
   * The wrapper (this process) survives and must reset these modes.
   */
  const EXIT_ALTERNATE_SCREEN_SEQUENCE = '\x1b[?1049l'
  const SAFE_TERMINAL_RESET_SEQUENCES =
    '\x1b[?1000l' + // Disable X10 mouse mode
    '\x1b[?1002l' + // Disable button event mouse mode
    '\x1b[?1003l' + // Disable any-event mouse mode (all motion)
    '\x1b[?1006l' + // Disable SGR extended mouse mode
    '\x1b[?1004l' + // Disable focus reporting
    '\x1b[?2004l' + // Disable bracketed paste mode
    '\x1b[<u' + // Pop kitty keyboard protocol flags
    '\x1b[>4;0m' + // Reset modifyOtherKeys
    '\x1b[?25h' // Show cursor

  const FULL_TERMINAL_RESET_SEQUENCES =
    EXIT_ALTERNATE_SCREEN_SEQUENCE + SAFE_TERMINAL_RESET_SEQUENCES

  function resetTerminal(options = {}) {
    const { exitAlternateScreen = false } = options

    try {
      if (process.stdin.isTTY && process.stdin.setRawMode) {
        process.stdin.setRawMode(false)
      }
    } catch {
      // stdin may be closed
    }
    try {
      if (process.stdout.isTTY) {
        // Exiting the alternate screen is only safe after an interactive child.
        // Plain CLI paths like --help never enter it, and ?1049l can erase output.
        process.stdout.write(
          exitAlternateScreen
            ? FULL_TERMINAL_RESET_SEQUENCES
            : SAFE_TERMINAL_RESET_SEQUENCES,
        )
      }
    } catch {
      // stdout may be closed
    }
  }

  /**
   * How long a binary has to survive before a crash stops looking like a
   * startup failure. Used to bound the STATUS_STACK_BUFFER_OVERRUN heuristic
   * below, which is only trustworthy for deaths during startup.
   */
  const STARTUP_CRASH_WINDOW_MS = 10000

  /** Bytes of the binary's stderr kept for the crash report. */
  const STDERR_TAIL_BYTES = 8192

  function getUnsignedExitCode(code) {
    return code != null && code < 0 ? code >>> 0 : code
  }

  function isWindowsNativeCrashCode(code) {
    const unsignedCode = getUnsignedExitCode(code)
    return (
      process.platform === 'win32' &&
      (unsignedCode === 0xc000001d ||
        unsignedCode === 0xc0000005 ||
        unsignedCode === 0xc0000409)
    )
  }

  function shouldExitAlternateScreen(code, signal) {
    return Boolean(signal) || isWindowsNativeCrashCode(code)
  }

  function isIllegalInstructionExit(code, signal) {
    const unsignedCode = getUnsignedExitCode(code)
    return (
      signal === 'SIGILL' ||
      (process.platform === 'win32' && unsignedCode === 0xc000001d)
    )
  }

  /**
   * A startup death that is probably this machine failing to run the optimized
   * build, reported under the *other* Windows spelling.
   *
   * Bun is written in Zig, and a Zig panic on Windows reports itself with
   * __fastfail(FAST_FAIL_FATAL_APP_EXIT) — NTSTATUS 0xC0000409
   * (STATUS_STACK_BUFFER_OVERRUN, exit code 3221226505), not
   * STATUS_ILLEGAL_INSTRUCTION. So a CPU without AVX2 does not reliably die on
   * the illegal instruction itself: Bun detects the missing feature, then
   * panics while starting up anyway (oven-sh/bun#28399), and the crash arrives
   * as 0xC0000409. Only the SIGILL spelling was wired to the baseline
   * fallback, which is why these machines crash-looped forever.
   *
   * On its own 0xC0000409 only means "the binary aborted", so this is bounded
   * to deaths during startup. A panic ten minutes into a session is an
   * ordinary bug, and reading it as a missing instruction set would send a
   * perfectly capable machine to the slower build.
   */
  function isStartupCpuFeatureCrash(code, signal, msAlive) {
    return (
      process.platform === 'win32' &&
      getUnsignedExitCode(code) === 0xc0000409 &&
      !signal &&
      typeof msAlive === 'number' &&
      msAlive < STARTUP_CRASH_WINDOW_MS
    )
  }

  function createConfig(packageName) {
    const homeDir = os.homedir()
    const configDir =
      configDirOverride || path.join(homeDir, '.config', 'manicode')
    const binaryName =
      process.platform === 'win32' ? `${packageName}.exe` : packageName

    return {
      homeDir,
      configDir,
      binaryName,
      binaryPath: path.join(configDir, binaryName),
      metadataPath: path.join(configDir, `${packageName}-metadata.json`),
      tempDownloadDir: path.join(configDir, tempDownloadDirName),
      userAgent: `${packageName}-cli`,
      requestTimeout: 20000,
      downloadRequestTimeout: 120000,
      downloadMaxAttempts: 3,
    }
  }

  const CONFIG = createConfig(packageName)
  const { downloadFile, httpGet, withRetries } = createReleaseHttpClient({
    env: process.env,
    userAgent: CONFIG.userAgent,
    requestTimeout: CONFIG.requestTimeout,
  })

  function getPostHogConfig() {
    const apiKey =
      process.env.CODEBUFF_POSTHOG_API_KEY ||
      process.env.NEXT_PUBLIC_POSTHOG_API_KEY
    const host =
      process.env.CODEBUFF_POSTHOG_HOST ||
      process.env.NEXT_PUBLIC_POSTHOG_HOST_URL

    if (!apiKey || !host) {
      return null
    }

    return { apiKey, host }
  }

  /**
   * Track update failure event to PostHog.
   * Fire-and-forget - errors are silently ignored.
   */
  function trackUpdateFailed(errorMessage, version, context = {}) {
    try {
      const posthogConfig = getPostHogConfig()
      if (!posthogConfig) {
        return
      }

      const payload = JSON.stringify({
        api_key: posthogConfig.apiKey,
        event: telemetryEvent,
        properties: {
          distinct_id: `anonymous-${CONFIG.homeDir}`,
          error: errorMessage,
          version: version || 'unknown',
          platform: process.platform,
          arch: process.arch,
          ...telemetryProperties,
          ...context,
        },
        timestamp: new Date().toISOString(),
      })

      const parsedUrl = new URL(`${posthogConfig.host}/capture/`)
      const isHttps = parsedUrl.protocol === 'https:'
      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      }

      const transport = isHttps ? https : http
      const req = transport.request(options)
      req.on('error', () => {}) // Silently ignore errors
      req.write(payload)
      req.end()
    } catch (e) {
      // Silently ignore any tracking errors
    }
  }

  const PLATFORM_TARGETS = {
    'linux-x64': `${packageName}-linux-x64.tar.gz`,
    'linux-x64-baseline': `${packageName}-linux-x64-baseline.tar.gz`,
    'linux-arm64': `${packageName}-linux-arm64.tar.gz`,
    'darwin-x64': `${packageName}-darwin-x64.tar.gz`,
    'darwin-arm64': `${packageName}-darwin-arm64.tar.gz`,
    'win32-x64': `${packageName}-win32-x64.tar.gz`,
    'win32-x64-baseline': `${packageName}-win32-x64-baseline.tar.gz`,
  }

  const BASELINE_FALLBACK_TARGETS = {
    'linux-x64': 'linux-x64-baseline',
    'win32-x64': 'win32-x64-baseline',
  }

  const term = {
    clearLine: () => {
      if (process.stderr.isTTY) {
        process.stderr.write('\r\x1b[K')
      }
    },
    write: (text) => {
      term.clearLine()
      process.stderr.write(text)
    },
    writeLine: (text) => {
      term.clearLine()
      process.stderr.write(text + '\n')
    },
  }

  function getPlatformKey() {
    return `${process.platform}-${process.arch}`
  }

  function getTargetOverride() {
    const envNames = [
      `${packageName.toUpperCase()}_BINARY_TARGET`,
      'CODEBUFF_BINARY_TARGET',
      'CLI_BINARY_TARGET',
    ]

    for (const envName of envNames) {
      const target = process.env[envName]
      if (target && PLATFORM_TARGETS[target]) {
        return target
      }
    }

    return null
  }

  function linuxCpuHasAvx2() {
    try {
      return /\bavx2\b/i.test(fs.readFileSync('/proc/cpuinfo', 'utf8'))
    } catch {
      return true
    }
  }

  let _hasAvx2Cache

  function machineHasAvx2() {
    if (_hasAvx2Cache === undefined) {
      _hasAvx2Cache = detectMachineHasAvx2()
    }
    return _hasAvx2Cache
  }

  function detectMachineHasAvx2() {
    if (process.arch !== 'x64') {
      return true
    }

    // A recorded illegal-instruction crash outranks everything below it: the
    // binary actually failed on this machine, which beats any inference we
    // could make about the CPU.
    const recorded = readCachedAvx2()
    if (recorded !== null) {
      return recorded
    }

    // Linux can just ask, and a file read is cheap enough not to cache.
    if (process.platform === 'linux') {
      return linuxCpuHasAvx2()
    }

    // Everything else assumes AVX2 — true of every x64 CPU since ~2013.
    //
    // Windows is the case that matters, since it's the only other platform with
    // a baseline build. It has no /proc/cpuinfo equivalent we can read without
    // spawning something, and the probe that used to fill the gap asked
    // PowerShell to compile a C# stub and P/Invoke
    // kernel32!IsProcessorFeaturePresent — accurate, but a textbook malware
    // shape that Windows Defender flagged as a "Suspicious PowerShell command
    // line" on real user machines. The illegal-instruction handler corrects us
    // instead: tryFallbackToBaseline() calls recordMachineLacksAvx2(), so a
    // machine without AVX2 pays exactly one failed launch and is answered by
    // the cache read above from then on.
    return true
  }

  // Called from the illegal-instruction fallback. Persisting here is what keeps
  // the optimistic assumption above from costing more than a single crash — and
  // it is deliberately separate from the metadata target, so a lost or rewritten
  // metadata file can't resurrect the AVX2 build on a CPU that can't run it.
  function recordMachineLacksAvx2() {
    _hasAvx2Cache = false
    writeCachedAvx2(false)
  }

  function getCpuFeatureCachePath() {
    return path.join(CONFIG.configDir, 'cpu-features.json')
  }

  function readCachedAvx2() {
    try {
      const cache = JSON.parse(
        fs.readFileSync(getCpuFeatureCachePath(), 'utf8'),
      )
      return typeof cache.avx2 === 'boolean' ? cache.avx2 : null
    } catch {
      return null
    }
  }

  function writeCachedAvx2(value) {
    try {
      fs.mkdirSync(CONFIG.configDir, { recursive: true })
      fs.writeFileSync(
        getCpuFeatureCachePath(),
        JSON.stringify({ avx2: value }),
      )
    } catch {
      // Best effort; we'll just re-probe next launch.
    }
  }

  function getDefaultTargetKey() {
    const override = getTargetOverride()
    if (override) {
      return override
    }

    const platformKey = getPlatformKey()
    // Linux still detects up front (reading /proc/cpuinfo is free). Windows
    // cannot without spawning a process, and the PowerShell probe that used to
    // do it tripped Defender, so Windows is optimistic-then-corrected: see
    // detectMachineHasAvx2() and tryFallbackToBaseline(). Once a machine has
    // failed once, readCachedAvx2() answers here and baseline is chosen up front
    // exactly as it used to be.
    //
    // This assumes every baseline target is gated on AVX2 specifically, which
    // holds today (only linux-x64 and win32-x64 have baseline builds, both
    // AVX2-gated). If a baseline build is ever added for a different reason, give
    // BASELINE_FALLBACK_TARGETS a per-target capability and check that instead.
    if (BASELINE_FALLBACK_TARGETS[platformKey] && !machineHasAvx2()) {
      return BASELINE_FALLBACK_TARGETS[platformKey]
    }

    return platformKey
  }

  function getBaselineFallbackTargetKey() {
    // Runtime safety net: if proactive detection was unavailable or wrong and the
    // optimized binary still dies with SIGILL, fall back to baseline.
    return BASELINE_FALLBACK_TARGETS[getPlatformKey()] || null
  }

  function isTargetAllowedForThisMachine(target) {
    const override = getTargetOverride()
    if (override) {
      return target === override
    }
    // Check the baseline fallback first: it's always safe on its platform and
    // avoids running CPU detection when a baseline binary is already installed.
    return (
      target === getBaselineFallbackTargetKey() ||
      target === getDefaultTargetKey()
    )
  }

  function getDownloadTargetKey() {
    const override = getTargetOverride()
    if (override) {
      return override
    }

    const metadata = getCurrentMetadata()
    if (metadata?.target && isTargetAllowedForThisMachine(metadata.target)) {
      return metadata.target
    }

    return getDefaultTargetKey()
  }

  async function getLatestVersion() {
    try {
      const res = await httpGet(
        `https://registry.npmjs.org/${packageName}/latest`,
      )

      if (res.statusCode !== 200) return null

      const body = await streamToString(res)
      const packageData = JSON.parse(body)

      return packageData.version || null
    } catch (error) {
      return null
    }
  }

  function streamToString(stream) {
    return new Promise((resolve, reject) => {
      let data = ''
      stream.on('data', (chunk) => (data += chunk))
      stream.on('end', () => resolve(data))
      stream.on('error', reject)
    })
  }

  function getCurrentVersion() {
    try {
      const metadata = getCurrentMetadata()
      if (!metadata) {
        return null
      }
      // Also verify the binary still exists
      if (!fs.existsSync(CONFIG.binaryPath)) {
        return null
      }
      const metadataTarget = metadata.target || getPlatformKey()
      if (!isTargetAllowedForThisMachine(metadataTarget)) {
        return null
      }
      return getMetadataVersion(metadata)
    } catch (error) {
      return null
    }
  }

  function getMetadataVersion(metadata) {
    return typeof metadata?.version === 'string' && metadata.version
      ? metadata.version
      : null
  }

  function getCurrentMetadata() {
    try {
      if (!fs.existsSync(CONFIG.metadataPath)) {
        return null
      }
      return JSON.parse(fs.readFileSync(CONFIG.metadataPath, 'utf8'))
    } catch {
      return null
    }
  }

  function parseVersion(version) {
    if (typeof version !== 'string') return null

    const match = version.match(
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
    )
    if (!match) return null

    const prerelease = match[4]?.split('.') ?? []
    if (prerelease.some((part) => /^0\d+$/.test(part))) return null

    return {
      main: match.slice(1, 4).map(BigInt),
      prerelease,
    }
  }

  function compareVersions(v1, v2) {
    const p1 = parseVersion(v1)
    const p2 = parseVersion(v2)

    // Published package versions are valid semver. Treat malformed cached
    // metadata as stale so the wrapper repairs it instead of trusting it.
    if (!p1) return -1
    if (!p2) return 1

    for (let i = 0; i < p1.main.length; i++) {
      if (p1.main[i] < p2.main[i]) return -1
      if (p1.main[i] > p2.main[i]) return 1
    }

    if (p1.prerelease.length === 0) {
      return p2.prerelease.length === 0 ? 0 : 1
    }
    if (p2.prerelease.length === 0) return -1

    for (
      let i = 0;
      i < Math.max(p1.prerelease.length, p2.prerelease.length);
      i++
    ) {
      const identifier1 = p1.prerelease[i]
      const identifier2 = p2.prerelease[i]
      if (identifier1 === undefined) return -1
      if (identifier2 === undefined) return 1
      if (identifier1 === identifier2) continue

      const numeric1 = /^\d+$/.test(identifier1)
      const numeric2 = /^\d+$/.test(identifier2)
      if (numeric1 && numeric2) {
        return BigInt(identifier1) < BigInt(identifier2) ? -1 : 1
      }
      if (numeric1 !== numeric2) return numeric1 ? -1 : 1
      return identifier1 < identifier2 ? -1 : 1
    }

    return 0
  }

  function formatBytes(bytes) {
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
  }

  function createProgressBar(percentage, width = 30) {
    const filled = Math.round((width * percentage) / 100)
    const empty = width - filled
    return '[' + '█'.repeat(filled) + '░'.repeat(empty) + ']'
  }

  function isRetryableDownloadError(error) {
    if (error && typeof error.retryable === 'boolean') return error.retryable
    return !['EACCES', 'ENOSPC', 'EPERM', 'EROFS'].includes(error?.code)
  }

  function getPartialArchivePath(version, targetKey) {
    return path.join(
      CONFIG.configDir,
      `.${packageName}-${version}-${targetKey}.tar.gz.part`,
    )
  }

  function getFileSize(filePath) {
    try {
      return fs.statSync(filePath).size
    } catch (error) {
      if (error.code === 'ENOENT') return 0
      throw error
    }
  }

  function removeFileIfPresent(filePath) {
    try {
      fs.unlinkSync(filePath)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }

  function formatDownloadSource(downloadUrl) {
    try {
      const parsedUrl = new URL(downloadUrl)
      return `${parsedUrl.origin}${parsedUrl.pathname}`
    } catch {
      return downloadUrl
    }
  }

  function printDownloadFailure(error) {
    const code = error.code ? ` (${error.code})` : ''
    console.error(
      `❌ Failed to download ${packageName}: ${error.message}${code}`,
    )

    if (error.requestUrl) {
      console.error(
        `Download source: ${formatDownloadSource(error.requestUrl)}`,
      )
    }
    if (error.downloadedBytes > 0) {
      const total = error.totalBytes
        ? ` of ${formatBytes(error.totalBytes)}`
        : ''
      console.error(
        `Saved ${formatBytes(error.downloadedBytes)}${total}; the next run will resume this download.`,
      )
    } else if (error.requestUrl) {
      console.error(
        'Please retry. The release host may be temporarily unavailable.',
      )
    } else {
      console.error(
        'The downloaded update could not be installed; the existing binary was preserved when possible.',
      )
    }
  }

  function prepareTempDownloadDir() {
    if (fs.existsSync(CONFIG.tempDownloadDir)) {
      fs.rmSync(CONFIG.tempDownloadDir, { recursive: true })
    }
    fs.mkdirSync(CONFIG.tempDownloadDir, { recursive: true })
  }

  async function downloadAndExtract(
    downloadUrl,
    version,
    targetKey,
    { quiet = false } = {},
  ) {
    let attempts = 0
    const partialArchivePath = getPartialArchivePath(version, targetKey)
    let totalBytes = null

    try {
      return await withRetries(
        async (attempt) => {
          attempts = attempt
          prepareTempDownloadDir()
          if (!quiet) term.write('Downloading...')

          let lastProgressTime = Date.now()
          const result = await downloadFile(downloadUrl, partialArchivePath, {
            timeout: CONFIG.downloadRequestTimeout,
            onProgress: ({ downloadedBytes, totalBytes: progressTotal }) => {
              totalBytes = progressTotal
              if (quiet) return
              const now = Date.now()
              if (
                now - lastProgressTime < 100 &&
                downloadedBytes !== progressTotal
              ) {
                return
              }
              lastProgressTime = now
              if (progressTotal) {
                const pct = Math.round((downloadedBytes / progressTotal) * 100)
                term.write(
                  `Downloading... ${createProgressBar(pct)} ${pct}% of ${formatBytes(progressTotal)}`,
                )
              } else {
                term.write(`Downloading... ${formatBytes(downloadedBytes)}`)
              }
            },
          })
          totalBytes = result.totalBytes

          try {
            await pipeline(
              fs.createReadStream(partialArchivePath),
              zlib.createGunzip(),
              tar.x({ cwd: CONFIG.tempDownloadDir }),
            )
          } catch (error) {
            // A complete archive that cannot be extracted is corrupt. Do not
            // resume it on the next attempt.
            removeFileIfPresent(partialArchivePath)
            throw error
          }

          const tempBinaryPath = path.join(
            CONFIG.tempDownloadDir,
            CONFIG.binaryName,
          )
          if (!fs.existsSync(tempBinaryPath)) {
            const files = fs.readdirSync(CONFIG.tempDownloadDir)
            removeFileIfPresent(partialArchivePath)
            const error = new Error(
              `Binary not found after extraction. Expected: ${CONFIG.binaryName}, Available files: ${files.join(', ')}`,
            )
            error.retryable = false
            throw error
          }

          removeFileIfPresent(partialArchivePath)
          return tempBinaryPath
        },
        {
          maxAttempts: CONFIG.downloadMaxAttempts,
          shouldRetry: isRetryableDownloadError,
          onRetry: ({ nextAttempt, delayMs }) => {
            if (quiet) return
            term.writeLine(
              `Download interrupted. Retrying in ${delayMs / 1000}s (${nextAttempt}/${CONFIG.downloadMaxAttempts})...`,
            )
          },
        },
      )
    } catch (error) {
      try {
        fs.rmSync(CONFIG.tempDownloadDir, { recursive: true, force: true })
      } catch {
        // Best effort after a failed download.
      }

      trackUpdateFailed(error.message, version, {
        stage: 'download',
        errorCode: error.code,
        statusCode: error.statusCode,
        target: targetKey,
        attempts,
        bytesDownloaded: getFileSize(partialArchivePath),
        totalBytes: error.totalBytes || totalBytes,
      })
      error.downloadedBytes = getFileSize(partialArchivePath)
      error.totalBytes ||= totalBytes
      error.requestUrl ||= downloadUrl
      throw error
    }
  }

  async function stageBinary(
    version,
    targetKey = getDownloadTargetKey(),
    options = {},
  ) {
    const fileName = PLATFORM_TARGETS[targetKey]

    if (!fileName) {
      const error = new Error(
        `Unsupported platform: ${process.platform} ${process.arch}`,
      )
      trackUpdateFailed(error.message, version, {
        stage: 'platform_check',
        target: targetKey,
      })
      throw error
    }

    const downloadUrl = `${
      process.env.NEXT_PUBLIC_CODEBUFF_APP_URL || 'https://codebuff.com'
    }/api/releases/download/${version}/${fileName}`

    fs.mkdirSync(CONFIG.configDir, { recursive: true })
    const tempBinaryPath = await downloadAndExtract(
      downloadUrl,
      version,
      targetKey,
      options,
    )

    try {
      if (process.platform !== 'win32') {
        fs.chmodSync(tempBinaryPath, 0o755)
      }
    } catch (error) {
      try {
        fs.rmSync(CONFIG.tempDownloadDir, { recursive: true, force: true })
      } catch {
        // Preserve the original chmod error.
      }
      throw error
    }

    return { tempBinaryPath, version, targetKey }
  }

  function replaceFileWithRollback(sourcePath, targetPath, replacements) {
    const backupPath = fs.existsSync(targetPath)
      ? `${targetPath}.old.${Date.now()}.${replacements.length}`
      : null

    if (backupPath) {
      fs.renameSync(targetPath, backupPath)
    }

    try {
      fs.renameSync(sourcePath, targetPath)
    } catch (error) {
      if (backupPath && fs.existsSync(backupPath)) {
        fs.renameSync(backupPath, targetPath)
      }
      throw error
    }

    replacements.push({ backupPath, targetPath })
  }

  function rollbackReplacements(replacements) {
    for (const { backupPath, targetPath } of replacements.reverse()) {
      removeFileIfPresent(targetPath)
      if (backupPath && fs.existsSync(backupPath)) {
        fs.renameSync(backupPath, targetPath)
      }
    }
  }

  function commitReplacements(replacements) {
    for (const { backupPath } of replacements) {
      if (!backupPath) continue
      try {
        removeFileIfPresent(backupPath)
      } catch {
        // The replacement is already committed. A stale backup is safer than
        // rolling back a working install because cleanup failed.
      }
    }
  }

  function installStagedBinary({ tempBinaryPath, version, targetKey }) {
    const replacements = []
    const metadataTempPath = `${CONFIG.metadataPath}.new.${process.pid}`

    try {
      fs.writeFileSync(
        metadataTempPath,
        JSON.stringify({ version, target: targetKey }, null, 2),
      )
      replaceFileWithRollback(tempBinaryPath, CONFIG.binaryPath, replacements)

      // Move tree-sitter.wasm next to the binary if the tarball included
      // it. The CLI binary loads this at startup; embedding it inside the
      // binary itself was unreliable on Windows (bun --compile asset
      // bundling silently dropped or unbound it across several attempts),
      // so we ship it as a sibling file instead. Older artifacts that
      // pre-date this change won't have the wasm and will still install —
      // they'll just hit the same crash they had before, which is fine.
      if (includeTreeSitterWasm) {
        const tempWasmPath = path.join(
          CONFIG.tempDownloadDir,
          'tree-sitter.wasm',
        )
        if (fs.existsSync(tempWasmPath)) {
          const targetWasmPath = path.join(
            path.dirname(CONFIG.binaryPath),
            'tree-sitter.wasm',
          )
          replaceFileWithRollback(tempWasmPath, targetWasmPath, replacements)
        }
      }

      replaceFileWithRollback(
        metadataTempPath,
        CONFIG.metadataPath,
        replacements,
      )
      commitReplacements(replacements)
    } catch (error) {
      rollbackReplacements(replacements)
      throw error
    } finally {
      removeFileIfPresent(metadataTempPath)
      if (fs.existsSync(CONFIG.tempDownloadDir)) {
        fs.rmSync(CONFIG.tempDownloadDir, { recursive: true })
      }
    }

    term.clearLine()
    console.log(`Download complete! Starting ${displayName}...`)
  }

  async function downloadBinary(version, targetKey = getDownloadTargetKey()) {
    const stagedBinary = await stageBinary(version, targetKey)
    installStagedBinary(stagedBinary)
  }

  function getRequiredWrapperVersion(currentVersion) {
    if (
      !wrapperVersion ||
      (currentVersion !== null &&
        compareVersions(currentVersion, wrapperVersion) >= 0)
    ) {
      return null
    }
    return wrapperVersion
  }

  async function ensureBinaryReady() {
    const currentVersion = getCurrentVersion()
    const requiredWrapperVersion = getRequiredWrapperVersion(currentVersion)

    if (currentVersion !== null && requiredWrapperVersion === null) {
      return
    }

    // npm installs update this JavaScript wrapper but intentionally preserve the
    // downloaded binary. If that binary exits before the background update
    // check starts, it can otherwise remain stuck forever. The wrapper and its
    // release binary share a version, so repair that stale cache synchronously
    // without adding a registry lookup to healthy launches.
    const version = requiredWrapperVersion ?? (await getLatestVersion())
    if (!version) {
      console.error('❌ Failed to determine latest version')
      console.error('Please check your internet connection and try again')
      process.exit(1)
    }

    try {
      await downloadBinary(version)
    } catch (error) {
      term.clearLine()
      printDownloadFailure(error)
      if (currentVersion !== null) {
        console.error(
          `Continuing with cached ${packageName} ${currentVersion}.`,
        )
        return
      }
      process.exit(1)
    }
  }

  function stopRunningProcess(runningProcess) {
    return new Promise((resolve, reject) => {
      let forceKillTimer
      let forceKillTimeout

      const cleanup = () => {
        clearTimeout(forceKillTimer)
        clearTimeout(forceKillTimeout)
        runningProcess.removeListener('exit', handleExit)
      }
      const handleExit = () => {
        cleanup()
        resolve()
      }
      const fail = (error) => {
        cleanup()
        reject(error)
      }

      runningProcess.once('exit', handleExit)
      forceKillTimer = setTimeout(() => {
        forceKillTimeout = setTimeout(() => {
          fail(new Error(`${packageName} did not exit after SIGKILL`))
        }, 1000)
        try {
          runningProcess.kill('SIGKILL')
        } catch (error) {
          fail(error)
        }
      }, 5000)
      try {
        runningProcess.kill('SIGTERM')
      } catch (error) {
        fail(error)
      }
    })
  }

  async function checkForUpdates(runningProcess, exitListener) {
    // main() schedules this 100ms after launch, so the binary it was handed can
    // already be dead — a startup crash that handed off to the baseline
    // fallback, most of all. Updating around a corpse would race that
    // relaunch's download for the shared temp directory (prepareTempDownloadDir
    // rmSyncs it) and then spend six seconds SIGKILLing a process that has
    // already exited.
    if (runningProcess.exitCode !== null || runningProcess.signalCode !== null) {
      return
    }

    let stoppedForUpdate = false

    try {
      const currentVersion = getCurrentVersion()

      const latestVersion = await getLatestVersion()
      if (!latestVersion) return

      if (
        // Download new version if current version is unknown or outdated.
        currentVersion === null ||
        compareVersions(currentVersion, latestVersion) < 0
      ) {
        const stagedBinary = await stageBinary(
          latestVersion,
          getDownloadTargetKey(),
          { quiet: true },
        )

        term.clearLine()

        runningProcess.removeListener('exit', exitListener)
        try {
          await stopRunningProcess(runningProcess)
        } catch (error) {
          runningProcess.on('exit', exitListener)
          throw error
        }
        stoppedForUpdate = true

        resetTerminal({ exitAlternateScreen: true })
        console.log(`Update available: ${currentVersion} → ${latestVersion}`)

        installStagedBinary(stagedBinary)

        const newChild = spawnInstalledBinary({ detached: false })
        attachExitHandler(newChild)

        return new Promise(() => {})
      }
    } catch (error) {
      if (stoppedForUpdate && fs.existsSync(CONFIG.binaryPath)) {
        console.error(
          `Update failed; restarting ${packageName} ${getCurrentVersion()}.`,
        )
        const child = spawnInstalledBinary({ detached: false })
        attachExitHandler(child)
        return new Promise(() => {})
      }
      try {
        fs.rmSync(CONFIG.tempDownloadDir, { recursive: true, force: true })
      } catch {
        // Best effort after a failed background update.
      }
      // A staging failure leaves the current process and binary untouched.
    }
  }

  /**
   * Make captured output safe to print back to the terminal.
   *
   * The tail is replayed *after* resetTerminal() has put the terminal back in
   * order, so it must not be able to undo that: a stray \x1b[?1049h or
   * \x1b[?1003h in what the binary printed would re-enter the alternate screen
   * or re-enable mouse reporting, hiding the very report it is part of. Strip
   * the escapes and keep the words.
   */
  function sanitizeForReplay(text) {
    if (!text) return ''
    return (
      text
        .replace(/\r\n?/g, '\n')
        // CSI sequences — the ones that actually change terminal state.
        .replace(/\x1b\[[0-9;:?<>=]*[ -/]*[@-~]/g, '')
        // Everything else: strip the control bytes and keep the text. An OSC
        // or a lone escape loses its introducer and degrades to inert
        // characters, which is all a crash report needs it to be.
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
        .replace(/\s+$/, '')
    )
  }

  function printCrashDiagnostics(code, signal, context = {}) {
    const { msAlive = null, stderrTail = '' } = context
    // Windows NTSTATUS codes (unsigned DWORD)
    const unsignedCode = getUnsignedExitCode(code)
    const isIllegalInstruction = isIllegalInstructionExit(code, signal)
    const isAccessViolation =
      signal === 'SIGSEGV' ||
      (process.platform === 'win32' && unsignedCode === 0xc0000005)
    const isBusError = signal === 'SIGBUS'
    const isAbort =
      signal === 'SIGABRT' ||
      (process.platform === 'win32' && unsignedCode === 0xc0000409)

    if (!isIllegalInstruction && !isAccessViolation && !isBusError && !isAbort)
      return

    const exitInfo = signal ? `signal ${signal}` : `code ${code}`
    console.error('')
    console.error(`❌ ${packageName} exited immediately (${exitInfo})`)
    console.error('')

    if (isIllegalInstruction) {
      console.error(
        'Your CPU may not support the required instruction set (AVX2).',
      )
      console.error('This typically affects CPUs from before 2013.')
      console.error('')
      printBaselineOverrideHint()
    } else if (isAccessViolation) {
      console.error('The binary crashed with an access violation.')
      console.error('')
    } else if (isBusError) {
      console.error('The binary crashed with a bus error.')
      console.error('This may indicate a platform compatibility issue.')
      console.error('')
    } else if (isAbort) {
      const startupCpuCrash = isStartupCpuFeatureCrash(code, signal, msAlive)
      console.error(
        startupCpuCrash
          ? 'The binary aborted while starting up.'
          : 'The binary crashed with an abort signal.',
      )
      console.error('')
      // Reached only once the baseline fallback has declined or failed, so name
      // the case the user can still act on instead of leaving them with an
      // abort code and a bug-tracker link.
      if (startupCpuCrash) {
        if (getCurrentMetadata()?.target === getBaselineFallbackTargetKey()) {
          console.error(
            'This is already the older-CPU (baseline) build, so a missing AVX2',
          )
          console.error(
            'instruction set is not the whole story — please include the output',
          )
          console.error('below in your report.')
          console.error('')
        } else {
          console.error(
            'On x64 Windows this is usually a CPU without AVX2 support, which',
          )
          console.error('the standard build requires.')
          console.error('')
          printBaselineOverrideHint()
        }
      }
    }

    printSystemInfo()
    const tailText = sanitizeForReplay(stderrTail)
    if (tailText) {
      console.error('')
      console.error(`Last output from ${packageName}:`)
      for (const line of tailText.split('\n')) {
        console.error(`  ${line}`)
      }
    }
    console.error('')
    console.error('Please report this issue at:')
    console.error(`  https://github.com/CodebuffAI/${packageName}/issues`)
    console.error('')
  }

  function printBaselineOverrideHint() {
    const fallbackTarget = getBaselineFallbackTargetKey()
    if (!fallbackTarget) return
    console.error('To force the baseline (non-AVX2) build, set:')
    console.error(
      `  ${packageName.toUpperCase()}_BINARY_TARGET=${fallbackTarget}`,
    )
    console.error('')
  }

  /**
   * What we actually know about AVX2, not what we assume.
   *
   * The old line printed a flat "yes" from machineHasAvx2(), which on Windows
   * is an optimistic default and not a measurement (see detectMachineHasAvx2).
   * Every crash report that reached us therefore claimed AVX2 was present on
   * machines we had never asked, which is exactly the evidence that would have
   * pointed at the CPU.
   */
  function describeAvx2Support() {
    if (readCachedAvx2() === false) return 'no (recorded crash)'
    if (process.platform === 'linux') return machineHasAvx2() ? 'yes' : 'no'
    return 'not checked (assumed present)'
  }

  function printSystemInfo() {
    const metadata = getCurrentMetadata()
    console.error('System info:')
    console.error(`  Platform: ${process.platform} ${process.arch}`)
    console.error(`  Node:     ${process.version}`)
    if (process.arch === 'x64') {
      console.error(`  AVX2:     ${describeAvx2Support()}`)
    }
    console.error(`  Target:   ${metadata?.target || getDefaultTargetKey()}`)
    console.error(`  Binary:   ${CONFIG.binaryPath}`)
  }

  function getInstalledBinaryStatus() {
    try {
      const stats = fs.statSync(CONFIG.binaryPath)
      return stats.isFile() ? `yes (${formatBytes(stats.size)})` : 'no'
    } catch {
      return 'no'
    }
  }

  function printSpawnFailure(err) {
    resetTerminal()
    const code = err && err.code ? ` (${err.code})` : ''

    console.error(`Failed to start ${packageName}: ${err.message}${code}`)
    console.error('')
    printSystemInfo()
    console.error(`  Exists:   ${getInstalledBinaryStatus()}`)

    if (process.platform === 'win32') {
      console.error('')
      console.error(
        'On Windows, this can happen when Windows Security or antivirus blocks',
      )
      console.error(
        'or quarantines the downloaded executable, or when the binary requires',
      )
      console.error('CPU instructions that are not available on this machine.')
      console.error('')
      printBaselineOverrideHint()
    }

    console.error('')
    console.error('Try deleting the downloaded files and running again:')
    console.error(`  ${CONFIG.configDir}`)
    console.error('')
  }

  function exitOnSpawnFailure(err) {
    printSpawnFailure(err)
    process.exit(1)
  }

  function spawnInstalledBinary(options = {}) {
    if (!fs.existsSync(CONFIG.binaryPath)) {
      try {
        if (fs.existsSync(CONFIG.metadataPath))
          fs.unlinkSync(CONFIG.metadataPath)
      } catch {
        // best effort
      }
      const error = new Error(
        `downloaded binary is missing at ${CONFIG.binaryPath}`,
      )
      error.code = 'BINARY_MISSING'
      exitOnSpawnFailure(error)
    }

    // spawn() only emits 'error' asynchronously for a few errno values
    // (EACCES, EAGAIN, EMFILE, ENFILE, ENOENT); everything else — notably
    // UNKNOWN on Windows when antivirus or Smart App Control blocks the
    // exe or the download is corrupt — is thrown synchronously.
    let child
    try {
      const { env: optionEnv, ...spawnOptions } = options
      child = spawn(CONFIG.binaryPath, process.argv.slice(2), {
        // stdin/stdout stay inherited — the TUI owns the terminal and must see
        // a real tty. stderr is teed on Windows only; see watchLaunch.
        stdio:
          process.platform === 'win32'
            ? ['inherit', 'inherit', 'pipe']
            : ['inherit', 'inherit', 'inherit'],
        ...spawnOptions,
        env: {
          ...process.env,
          ...optionEnv,
          CODEBUFF_LAUNCHER_PID: String(process.pid),
        },
      })
    } catch (err) {
      exitOnSpawnFailure(err)
    }

    child.on('error', exitOnSpawnFailure)
    child.launch = watchLaunch(child)

    return child
  }

  /**
   * Watch a launch so its death can be explained: how long the binary lived,
   * and what it printed on the way out.
   *
   * The stderr tee is what makes a crash report self-contained. When the binary
   * dies natively we reset the terminal, and that reset leaves the alternate
   * screen with \x1b[?1049l — discarding its contents, including any panic Bun
   * printed there. (The CLI's own terminal watchdog sends the same sequence, so
   * dropping it here wouldn't help.) Every report of codebuff#792 is a launcher
   * message with no panic text above it; keeping a copy means the next one
   * arrives with Bun's own words in it.
   *
   * Only Windows pipes stderr — that's where the reports come from, and
   * everywhere else stderr stays a real tty.
   */
  function watchLaunch(child) {
    const startedAt = Date.now()
    const chunks = []
    let bufferedBytes = 0

    child.stderr?.on('data', (chunk) => {
      try {
        // Straight through: as far as the binary and the user are concerned,
        // this is still its terminal.
        process.stderr.write(chunk)
      } catch {
        // stderr may be closed
      }
      chunks.push(chunk)
      bufferedBytes += chunk.length
      while (bufferedBytes > STDERR_TAIL_BYTES && chunks.length > 1) {
        bufferedBytes -= chunks.shift().length
      }
    })

    return {
      msAlive: () => Date.now() - startedAt,
      stderrTail: () =>
        Buffer.concat(chunks).toString('utf8').slice(-STDERR_TAIL_BYTES),
      // 'exit' can beat the last bytes through the pipe; 'close' is the event
      // that means the stdio is drained too. The timeout is a bound on a stuck
      // pipe and is deliberately NOT unref'd — an unref'd timer lets the
      // process exit before it fires, which would swallow the crash report
      // entirely. Already-drained streams resolve without waiting for it.
      drained: () =>
        child.stderr && !child.stderr.readableEnded
          ? new Promise((resolve) => {
              child.once('close', resolve)
              child.stderr.once('end', resolve)
              setTimeout(resolve, 250)
            })
          : Promise.resolve(),
    }
  }

  async function tryFallbackToBaseline(code, signal, msAlive) {
    // Two spellings of one failure, at two levels of certainty. SIGILL /
    // STATUS_ILLEGAL_INSTRUCTION is proof this CPU cannot run this build; a
    // Windows startup abort is a strong suspicion (see isStartupCpuFeatureCrash).
    const confirmed = isIllegalInstructionExit(code, signal)
    if (!confirmed && !isStartupCpuFeatureCrash(code, signal, msAlive)) {
      return false
    }

    const fallbackTarget = getBaselineFallbackTargetKey()
    if (!fallbackTarget) {
      return false
    }

    // An explicit target is the user's decision; don't download over it.
    if (getTargetOverride()) {
      return false
    }

    const metadata = getCurrentMetadata()
    const currentTarget = metadata?.target || getDefaultTargetKey()
    if (currentTarget === fallbackTarget) {
      return false
    }

    // Only a confirmed illegal instruction gets written down. Persisting it
    // before the download is what caps the cost at one crash: even if the
    // download or the relaunch fails, we never optimistically pick the AVX2
    // build again. A suspected crash records nothing — installing the baseline
    // already keeps this machine on it, so a guess that turns out to be wrong
    // costs the slower build instead of leaving cpu-features.json asserting a
    // CPU limitation we never observed.
    if (confirmed) {
      recordMachineLacksAvx2()
    }

    const version = metadata?.version || (await getLatestVersion())
    if (!version) {
      return false
    }

    resetTerminal({
      exitAlternateScreen: shouldExitAlternateScreen(code, signal),
    })
    console.error('')
    console.error(
      confirmed
        ? `${packageName} is switching to the older-CPU binary for this machine.`
        : `${packageName} crashed on startup; trying the older-CPU binary.`,
    )

    try {
      await downloadBinary(version, fallbackTarget)
    } catch (error) {
      term.clearLine()
      console.error(`Failed to download ${fallbackTarget}: ${error.message}`)
      return false
    }

    const child = spawnInstalledBinary({ detached: false })
    attachExitHandler(child, false)
    return true
  }

  function attachExitHandler(child, allowBaselineFallback = true) {
    const exitListener = async (code, signal) => {
      // A child we never watched (only reachable from a test) reports no age
      // rather than a suspiciously young one: absent evidence must not be read
      // as a startup crash and trigger a download.
      const msAlive = child.launch ? child.launch.msAlive() : Infinity

      let stderrTail = ''
      if (child.launch && (isWindowsNativeCrashCode(code) || signal)) {
        await child.launch.drained()
        stderrTail = child.launch.stderrTail()
      }

      if (
        allowBaselineFallback &&
        (await tryFallbackToBaseline(code, signal, msAlive))
      ) {
        return
      }

      resetTerminal({
        exitAlternateScreen: shouldExitAlternateScreen(code, signal),
      })
      printCrashDiagnostics(code, signal, { msAlive, stderrTail })
      process.exit(signal ? 1 : code || 0)
    }

    child.on('exit', exitListener)
    return exitListener
  }

  async function main() {
    for (const line of startupBanner) {
      console.log(line)
    }
    if (startupBanner.length > 0) console.log('')

    await ensureBinaryReady()

    const child = spawnInstalledBinary()
    const exitListener = attachExitHandler(child)

    setTimeout(() => {
      checkForUpdates(child, exitListener)
    }, 100)
  }

  return {
    config: productConfig,
    main,
    stopRunningProcess,
    // Internals exposed for tests only. The AVX2 path is optimistic-then-
    // corrected (see detectMachineHasAvx2), so the correction has to be
    // exercised directly — there is no way to make a CI runner lack AVX2.
    __testing: {
      detectMachineHasAvx2,
      recordMachineLacksAvx2,
      readCachedAvx2,
      isIllegalInstructionExit,
      isStartupCpuFeatureCrash,
      tryFallbackToBaseline,
      printCrashDiagnostics,
      checkForUpdates,
      spawnInstalledBinary,
      attachExitHandler,
      getDefaultTargetKey,
      getCpuFeatureCachePath,
      getCurrentVersion,
      getMetadataVersion,
      getRequiredWrapperVersion,
      ensureBinaryReady,
      isTargetAllowedForThisMachine,
      CONFIG,
    },
  }
}

module.exports = { createLauncher }
