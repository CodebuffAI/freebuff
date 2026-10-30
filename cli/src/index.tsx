#!/usr/bin/env bun

// Embed tree-sitter.wasm into the bun-compile binary at a bunfs path the runtime
// can find. Without this, web-tree-sitter resolves the wasm via require.resolve,
// which (since 0.25.10's split exports map) returns the build-time absolute path
// of tree-sitter.cjs and fails on user machines. Must run before the SDK / code-map
// import chain triggers Parser.init.
import './pre-init/tree-sitter-wasm'

import fs from 'fs'
import os from 'os'
import path from 'path'

import { AnalyticsEvent } from '@codebuff/common/constants/analytics-events'
import { getProjectFileTree } from '@codebuff/common/project-file-tree'
import { getDefaultAgentDirs, getWebsiteUrl } from '@codebuff/sdk'
import {
  createCliRenderer,
  resolveRenderLib,
  setRenderLibPath,
} from '@opentui/core'
import { createRoot } from '@opentui/react'
import {
  QueryClient,
  QueryClientProvider,
  focusManager,
} from '@tanstack/react-query'
import { cyan, green, red, yellow } from 'picocolors'
import React from 'react'

import { App } from './app'
import { loadPackageVersion, parseArgs } from './cli-args'
import { handlePublish } from './commands/publish'
import { runPlainLogin } from './login/plain-login'
import { initializeApp } from './init/init-app'
import { getProjectRoot, setProjectRoot } from './project-files'
import { trackEvent } from './utils/analytics'
import { captureCliFunnel } from './utils/cli-product-funnel'
import { installAiSdkWarningLogger } from './utils/ai-sdk-warnings'
import {
  getTrustStorePath,
  isTruthyOptIn,
  promptForAgentDirTrust,
  resolveTrustedAgentDirs,
} from './utils/agent-dir-trust'
import {
  getAuthToken,
  getAuthTokenDetails,
  loadStoredAuthToken,
} from './utils/auth'
import { resetCodebuffClient } from './utils/codebuff-client'
import { setApiClientAuthToken } from './utils/codebuff-api'
import { IS_FREEBUFF } from './utils/constants'
import {
  describeForeignPreload,
  foreignPreloadFrom,
  REFUSE_FOREIGN_PRELOAD,
} from './utils/preload-guard'
import { getCliEnv } from './utils/env'
import { getConfigDir, tightenConfigDirMode } from './utils/config-dir'
import {
  bunExtractionTempDir,
  defaultRenderLibraryCacheDir,
  ensureRenderLibrary,
  findEmbeddedRenderLibrary,
  sweepLeakedRenderLibraryCopies,
} from './utils/opentui-native-library'
import { initializeAgentRegistry } from './utils/local-agent-registry'
import { trimOversizedChatLogs } from './utils/chat-history'
import { clearLogFile, logger } from './utils/logger'
import { drainClientLogs } from './utils/log-shipper'
import { takePreviousFatalCrash } from './utils/fatal-crash-report'
import { shouldShowProjectPicker } from './utils/project-picker'
import { saveRecentProject } from './utils/recent-projects'
import { startEngagementTracking } from './utils/engagement'
import {
  CLI_RENDERER_EXIT_SIGNALS,
  exitCliWithFatalError,
  installProcessCleanupHandlers,
} from './utils/renderer-cleanup'
import { startWindowsMachineProcessCensus } from './utils/helper-process-telemetry'
import { startTerminalWatchdog } from './utils/terminal-watchdog'
import { installTerminalProtocolController } from './utils/terminal-protocol-controller'
import { initializeSkillRegistry } from './utils/skill-registry'
import {
  detectTerminalTheme,
  detectTerminalThemeWithSupportTestHook,
} from './utils/terminal-color-detection'
import {
  noteTerminalColorReply,
  startClientEnvironmentProbe,
} from './utils/client-environment'
import { applyOscDetectedTheme } from './utils/theme-system'

import type { FileTreeNode } from '@codebuff/common/util/file'

// Configure TanStack Query's focusManager for terminal environments
// This is required because there's no browser visibility API in terminal apps
// Without this, refetchInterval won't work because TanStack Query thinks the app is "unfocused"
focusManager.setEventListener(() => {
  // No-op: no event listeners in CLI environment (no window focus/visibility events)
  return () => {}
})
focusManager.setFocused(true)

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5 * 60 * 1000, // 5 minutes - auth tokens don't change frequently
        gcTime: 10 * 60 * 1000, // 10 minutes - keep cached data a bit longer
        retry: false, // Don't retry failed auth queries automatically
        refetchOnWindowFocus: false, // CLI doesn't have window focus
        refetchOnReconnect: true, // Refetch when network reconnects
        refetchOnMount: false, // Don't refetch on every mount
      },
      mutations: {
        retry: 1, // Retry mutations once on failure
      },
    },
  })
}

async function main(): Promise<void> {
  // Before anything else: report an injected preload (preload-guard.ts). The
  // hook itself runs earlier, so this is a speed bump — see that file.
  const injectedPreload = foreignPreloadFrom({
    execArgv: process.execArgv,
    // A repository's own bunfig `preload` is ordinary use, not an injection.
    cwd: process.cwd(),
    // Best-effort second channel: a compiled binary reports its own modules
    // under `/$bunfs/`, and Bun may not expose a CommonJS `require` here.
    loadedModules: (() => {
      try {
        const cache = (
          globalThis as { require?: { cache?: Record<string, unknown> } }
        ).require?.cache
        return cache ? Object.keys(cache) : []
      } catch {
        return []
      }
    })(),
  })
  if (injectedPreload) {
    // No user-facing switch: the policy is `REFUSE_FOREIGN_PRELOAD`, fixed at
    // build time (preload-guard.ts), and the default reports and continues so
    // a legitimate toolchain hook never strands the CLI. The preload has run
    // by now either way, which is why nothing here asks the user to do anything.
    console.error(describeForeignPreload(injectedPreload))
    if (REFUSE_FOREIGN_PRELOAD) process.exit(1)
  }

  // CI gate: `<binary> --smoke-tree-sitter` proves the embedded wasm boots
  // through Parser.init end-to-end. Has to live BEFORE commander.parse() —
  // an earlier attempt put this in a pre-init module with top-level await,
  // and on Windows that didn't actually pause module evaluation (commander
  // still ran first and rejected the unknown flag).
  if (process.argv.includes('--smoke-tree-sitter')) {
    const wasmBinary = (
      globalThis as { __CODEBUFF_TREE_SITTER_WASM_BINARY__?: Uint8Array }
    ).__CODEBUFF_TREE_SITTER_WASM_BINARY__
    const wasmPath = (
      globalThis as { __CODEBUFF_TREE_SITTER_WASM_PATH__?: string }
    ).__CODEBUFF_TREE_SITTER_WASM_PATH__

    // Diagnostic dump so CI logs (and bug reports) show exactly what
    // the runtime saw when smoke fails. process.execPath, the
    // siblingPath we expect, and what's actually in that directory.
    const fs = await import('fs')
    const path = await import('path')
    const execDir = path.dirname(process.execPath)
    const siblingPath = path.join(execDir, 'tree-sitter.wasm')
    let dirListing: string[] = []
    try {
      dirListing = fs.readdirSync(execDir)
    } catch (err) {
      dirListing = [
        `<readdir failed: ${err instanceof Error ? err.message : err}>`,
      ]
    }
    console.error(
      `[smoke diag] execPath=${process.execPath}\n` +
        `[smoke diag] execDir=${execDir}\n` +
        `[smoke diag] siblingPath=${siblingPath}\n` +
        `[smoke diag] siblingExists=${fs.existsSync(siblingPath)}\n` +
        `[smoke diag] dir contents (${dirListing.length}): ${dirListing.slice(0, 30).join(', ')}\n` +
        `[smoke diag] globalThis wasmPath=${wasmPath ?? '<unset>'}\n` +
        `[smoke diag] globalThis wasmBinary bytes=${wasmBinary?.byteLength ?? 0}\n`,
    )

    try {
      const { Parser } = await import('web-tree-sitter')
      // Pick the best wasm source available, falling back to the
      // sibling-of-execPath lookup if pre-init couldn't reach it. By
      // main() time process.execPath has stabilized to the disk path
      // even on Windows, where it was the bunfs path during pre-init.
      let effectiveBinary = wasmBinary
      let effectivePath = wasmPath
      if (!effectiveBinary && !effectivePath && fs.existsSync(siblingPath)) {
        effectivePath = siblingPath
        effectiveBinary = new Uint8Array(fs.readFileSync(siblingPath))
      }

      if (effectiveBinary) {
        await Parser.init({ wasmBinary: effectiveBinary })
        // Marker grepped by cli/scripts/smoke-binary.ts — keep this exact text.
        console.log(
          `tree-sitter smoke ok (wasmBinary, ${effectiveBinary.byteLength} bytes)`,
        )
      } else if (effectivePath) {
        await Parser.init({
          locateFile: (name: string) =>
            name === 'tree-sitter.wasm' ? effectivePath! : name,
        })
        console.log(`tree-sitter smoke ok (locateFile, path=${effectivePath})`)
      } else {
        console.error(
          'tree-sitter smoke FAIL: no wasm available — pre-init published ' +
            'nothing and the sibling-of-execPath fallback also missed. See ' +
            'the diag above for paths.',
        )
        process.exit(1)
      }
      process.exit(0)
    } catch (err) {
      console.error('tree-sitter smoke FAIL:', err)
      process.exit(1)
    }
  }

  // CI gate: `<binary> --smoke-api-url` prints the backend URL the SDK resolved
  // and exits, so cli/scripts/smoke-binary.ts can prove dotenv files in the CWD
  // cannot steer it (see --no-compile-autoload-dotenv in build-binary.ts). Must
  // precede commander.parse(), which rejects unknown flags.
  if (process.argv.includes('--smoke-api-url')) {
    // Marker parsed by cli/scripts/smoke-binary.ts — keep this exact prefix.
    console.log(`api-url smoke: ${getWebsiteUrl()}`)
    process.exit(0)
  }

  // Native-Windows release gate. The external harness starts the packaged
  // binary inside winpty so this exercises a real console, OpenTUI renderer,
  // console-free broker, Git Bash child, and SDK process lifecycle.
  // Keep this before commander.parse(), which intentionally knows nothing
  // about internal smoke-only flags.
  const terminalBrokerSmokeIndex = process.argv.indexOf(
    '--smoke-terminal-broker',
  )
  const endOfOptionsIndex = process.argv.indexOf('--')
  const isTerminalBrokerSmoke =
    terminalBrokerSmokeIndex !== -1 &&
    (endOfOptionsIndex === -1 || terminalBrokerSmokeIndex < endOfOptionsIndex)
  if (isTerminalBrokerSmoke) {
    const resultPath = process.argv[terminalBrokerSmokeIndex + 1]
    const exchangeDir = process.argv[terminalBrokerSmokeIndex + 2]
    if (!resultPath || !exchangeDir) {
      console.error(
        'terminal broker smoke requires <result-path> <exchange-dir>',
      )
      process.exit(2)
    }
    const { runPackagedTerminalBrokerSmoke } =
      await import('./smoke/terminal-command-broker')
    const exitCode = await runPackagedTerminalBrokerSmoke({
      resultPath,
      exchangeDir,
    })
    process.exit(exitCode)
  }

  // Start OSC theme detection in the background, BEFORE OpenTUI starts.
  //
  // Render must not wait on it: the probe deadline is GLOBAL_OSC_TIMEOUT_MS
  // (2s) and terminals that swallow OSC queries (misconfigured tmux, some
  // SSH muxes) used to burn all of it before anything painted. The first
  // frame instead uses the synchronous evidence (COLORFGBG / TERM_BACKGROUND
  // / per-terminal fallbacks) and the answer is applied when it lands, via
  // the same live re-theme path the theme file watchers and SIGUSR2 use —
  // the theme resolver reads the OSC slot first once it is set, so the
  // settled theme is the one the old await-first startup produced whenever
  // the terminal answered the query.
  //
  // The strict ordering against createCliRenderer() (which puts stdin in raw
  // mode and attaches its parser) is what keeps the reply out of the key
  // event stream: STARTING detection ahead of the renderer attaches the OSC
  // data listener first, so the reply is consumed as the probe answer rather
  // than arriving as stray keystrokes at the focused input.
  let oscThemePromise: Promise<'dark' | 'light' | null>
  if (process.stdin.isTTY && process.platform !== 'win32') {
    oscThemePromise = detectTerminalTheme()
  } else {
    oscThemePromise = detectTerminalThemeWithSupportTestHook(false)
  }
  // Deferred: the settle handler flips the theme live once the theme code is
  // up (initializeApp → initializeThemeStore installs the resolver and
  // updater), but a settle attached here would fire between direnv and the
  // store init — it would record a result the initial detectSystemTheme()
  // then re-reads through the same detector order, so the settled theme is
  // unchanged; attaching at the first settle point just keeps the OSC reply
  // from driving a reactive update against a half-initialized store.
  let oscThemePromiseSettled = false
  const settleOscDetection = () => {
    if (oscThemePromiseSettled) return
    oscThemePromiseSettled = true
    oscThemePromise
      .then((oscTheme) => {
        noteTerminalColorReply(oscTheme !== null)
        applyOscDetectedTheme(oscTheme)
      })
      .catch(() => {
        // Silently ignore OSC detection failures
      })
  }

  // Transcripts, run state and prompt history live under the config dir;
  // keep it owner-only even if it was first created without a mode.
  tightenConfigDirMode()

  // The Freebuff auth token lives in the OS keychain (auth-token-store.ts):
  // load it before anything reads the credentials. Bounded and never throws.
  //
  // Not awaited inline. The keychain round-trip is IPC and used to sit ahead
  // of parseArgs/agent-registry/renderer creation, none of which reads the
  // token. The only sync reads real sessions make afterwards — the effect in
  // AppWithAsyncAuth and the useAuthQuery/useAuthState hooks — run post-paint
  // (React effects fire after the first frame is requested) or wait on the
  // user, so the keychain answer is in the credentials cache by then. The
  // awaits listed below close the remaining pre-paint windows:
  //   - commands that exit instead of rendering (login / publish),
  //   - the analytics rows (token must be classified before they ship;
  //     shipped rows leave the process, so post-settle rows must not flip),
  //   - the fallback before the renderer when we could not get far enough
  //     ahead of it (slow trusts/registry or non-TTY runs).
  // Fully-overlapped users keep the spare latency for a clearer startup; the
  // token never gates the first paint.
  const storedAuthTokenPromise = loadStoredAuthToken()

  const {
    initialPrompt,
    command,
    agent,
    clearLogs,
    continue: continueChat,
    continueId,
    cwd,
    initialMode,
    trustAgents,
  } = parseArgs()

  // The agent registry/build may repaint before the renderer (non-TTY, trust
  // prompts), so the OSC settle attaches before anything else can output.
  settleOscDetection()

  const isLoginCommand = command === 'login'
  const isPublishCommand = command === 'publish'
  const hasAgentOverride = Boolean(agent?.trim())

  await initializeApp({ cwd })

  // Set the auth token for the API client
  setApiClientAuthToken(getAuthToken())

  captureCliFunnel(
    'launch',
    'started',
    {
      entry_account_state: getAuthToken() ? 'stored_credentials' : 'signed_out',
    },
    'launch',
  )

  // Handle login command before rendering the app. Login rewrites the
  // credentials, so it must not race the startup keychain read.
  if (isLoginCommand) {
    await storedAuthTokenPromise
    await runPlainLogin()
    return
  }

  // Show project picker only when user starts at the home directory or an ancestor
  const projectRoot = getProjectRoot()
  const homeDir = os.homedir()
  const startCwd = process.cwd()
  const showProjectPicker = shouldShowProjectPicker(startCwd, homeDir)
  if (!showProjectPicker)
    captureCliFunnel(
      'context',
      'succeeded',
      { project_kind: 'local' },
      'initial',
    )

  // Requires analytics to be initialized, which is done in initializeApp.
  // The token settles first: analytics rows ship without a retry, so the
  // launch/crash rows must not record a sign-in state the keychain read
  // would have overturned one tick later.
  await storedAuthTokenPromise
  trackEvent(AnalyticsEvent.APP_LAUNCHED, {
    version: loadPackageVersion(),
    platform: process.platform,
    arch: process.arch,
    hasInitialPrompt: Boolean(initialPrompt),
    hasAgentOverride: hasAgentOverride,
    continueChat,
    initialMode: initialMode ?? 'DEFAULT',
    isFreeBuff: IS_FREEBUFF,
    // The npm wrapper's version, null when not started by one. Wrappers never
    // update themselves, and only newer ones adopt an update the terminal
    // closed on, so this splits "pinned build" by install path.
    launcherVersion:
      getCliEnv().CODEBUFF_LAUNCHER_VERSION?.slice(0, 32) ?? null,
  })
  // The previous launch died on a fatal error and could only leave a local
  // report on its way out; ship it now (fatal-crash-report.ts).
  const previousCrash = takePreviousFatalCrash()
  if (previousCrash) {
    try {
      trackEvent(AnalyticsEvent.CLI_FATAL_CRASH, previousCrash)
      void drainClientLogs()
    } catch {
      // Crash telemetry must never block a launch.
    }
  }
  // Start shipping the launch row now, well before the Windows watchdog is
  // armed. If endpoint security terminates this process during that spawn, the
  // next --continue launch still has a prior row for the health dashboard's
  // rapid-resume and interruption joins.
  if (IS_FREEBUFF && process.platform === 'win32') {
    void drainClientLogs()
  }

  // Initialize agent registry (loads user agents via SDK).
  // When --agent is provided, skip local .agents to avoid overrides.
  // Repository-scoped .agents directories (cwd and its parent) execute code
  // on import and spawn mcp.json servers, so they pass the trust gate first;
  // ~/.agents is the user's own and is always loaded.
  if (isPublishCommand || !hasAgentOverride) {
    const { agentDirs, skippedDirs } = await resolveTrustedAgentDirs({
      candidateDirs: getDefaultAgentDirs(),
      homeAgentsDir: path.join(os.homedir(), '.agents'),
      interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
      trustAll:
        trustAgents || isTruthyOptIn(getCliEnv().CODEBUFF_TRUST_AGENT_DIRS),
      storePath: getTrustStorePath(),
      prompt: promptForAgentDirTrust,
      notify: (message) => {
        console.log(yellow(message))
      },
    })
    if (skippedDirs.length > 0) {
      logger.warn(
        { skippedDirs },
        '[agents] Untrusted repository .agents directories were not loaded',
      )
    }
    await initializeAgentRegistry({ agentDirs })
  }

  // Initialize skill registry (loads skills from .agents/skills)
  await initializeSkillRegistry()

  // Handle publish command before rendering the app. Publishing signs the
  // request with the stored token, so the keychain read must have settled.
  if (isPublishCommand) {
    await storedAuthTokenPromise
    const publishIndex = process.argv.indexOf('publish')
    const agentIds = process.argv.slice(publishIndex + 1)
    const result = await handlePublish(agentIds)

    if (result.success && result.publisherId && result.agents) {
      logger.info(green('✅ Successfully published:'))
      for (const agent of result.agents) {
        logger.info(
          cyan(
            `  - ${agent.displayName} (${result.publisherId}/${agent.id}@${agent.version})`,
          ),
        )
      }
      process.exit(0)
    } else {
      logger.error(red('❌ Publish failed'))
      if (result.error) logger.error(red(`Error: ${result.error}`))
      if (result.details) logger.error(red(result.details))
      if (result.hint) logger.warn(yellow(`Hint: ${result.hint}`))
      process.exit(1)
    }
  }

  if (clearLogs) {
    clearLogFile()
  }

  // Reclaim disk from oversized debug logs left by older versions that logged
  // the full conversation to log.jsonl. Deferred to keep the stat sweep over
  // chat directories off the startup path.
  setTimeout(trimOversizedChatLogs, 0)

  const queryClient = createQueryClient()

  const AppWithAsyncAuth = () => {
    const [requireAuth, setRequireAuth] = React.useState<boolean | null>(null)
    const [hasInvalidCredentials, setHasInvalidCredentials] =
      React.useState(false)
    const [fileTree, setFileTree] = React.useState<FileTreeNode[]>([])
    const [currentProjectRoot, setCurrentProjectRoot] =
      React.useState(projectRoot)
    const [showProjectPickerScreen, setShowProjectPickerScreen] =
      React.useState(showProjectPicker)

    React.useEffect(() => {
      const apiKey = getAuthTokenDetails().token ?? ''

      if (!apiKey) {
        setRequireAuth(true)
        setHasInvalidCredentials(false)
        return
      }

      setHasInvalidCredentials(true)
      setRequireAuth(false)
    }, [])

    const loadFileTree = React.useCallback(async (root: string) => {
      try {
        if (root) {
          const tree = await getProjectFileTree({
            projectRoot: root,
            fs: fs.promises,
          })
          setFileTree(tree)
        }
      } catch (error) {
        // Silently fail - fileTree is optional for @ menu
      }
    }, [])

    React.useEffect(() => {
      loadFileTree(currentProjectRoot)
    }, [currentProjectRoot, loadFileTree])

    // Callback for when user selects a new project from the picker
    const handleProjectChange = React.useCallback(
      async (newProjectPath: string) => {
        // Change process working directory
        process.chdir(newProjectPath)
        captureCliFunnel('context', 'succeeded', { project_kind: 'folder' })

        // Track directory change (avoid logging full paths for privacy)
        const isGitRepo = fs.existsSync(path.join(newProjectPath, '.git'))
        const pathDepth = newProjectPath.split(path.sep).filter(Boolean).length
        trackEvent(AnalyticsEvent.CHANGE_DIRECTORY, {
          isGitRepo,
          pathDepth,
          isHomeDir: newProjectPath === os.homedir(),
        })
        // Update the project root in the module state
        setProjectRoot(newProjectPath)
        // Reset client to ensure tools use the updated project root
        resetCodebuffClient()
        // Save to recent projects list
        saveRecentProject(newProjectPath)
        // Update local state
        setCurrentProjectRoot(newProjectPath)
        // Reset file tree state to trigger reload
        setFileTree([])
        // Hide the picker and show the chat
        setShowProjectPickerScreen(false)
      },
      [],
    )

    return (
      <App
        initialPrompt={initialPrompt}
        agentId={agent}
        requireAuth={requireAuth}
        hasInvalidCredentials={hasInvalidCredentials}
        fileTree={fileTree}
        continueChat={continueChat}
        continueChatId={continueId ?? undefined}
        initialMode={initialMode}
        showProjectPicker={showProjectPickerScreen}
        onProjectChange={handleProjectChange}
      />
    )
  }

  // Install early error handlers BEFORE renderer creation.
  // If the renderer crashes during init, these ensure the error is visible
  // by exiting the alternate screen buffer before printing the error.
  const earlyFatalHandler = (error: unknown) =>
    exitCliWithFatalError('Fatal error during startup', error)
  process.on('uncaughtException', earlyFatalHandler)
  process.on('unhandledRejection', earlyFatalHandler)

  // Last line of defense for uncatchable deaths (SIGKILL, native crashes,
  // kill sweeps that also take out the npm wrapper): a detached process
  // (sh on POSIX, PowerShell on Windows) that resets the terminal when this
  // process disappears. Started before the renderer begins enabling terminal
  // modes; the clean-shutdown path (renderer-cleanup) disarms it.
  startTerminalWatchdog()
  // Windows only: count powershell/conhost/bash/cmd machine-wide every ten
  // minutes and report a flood (cli.helper_process_flood) — the symptom users
  // see in Task Manager, which nothing server-side can observe.
  startWindowsMachineProcessCensus()
  // Background, one-time; the descriptor reads `unknown` until it resolves.
  if (IS_FREEBUFF) void startClientEnvironmentProbe()

  // The SDK defaults to process.emitWarning(), which bypasses OpenTUI's
  // console capture and overwrites whichever terminal rows were last drawn.
  const restoreAiSdkWarnings = installAiSdkWarningLogger((warnings) =>
    logger.warn(warnings, 'AI SDK warning'),
  )
  // Load the native renderer up front, so a temp directory that is full,
  // read-only or noexec gets a fallback copy and, failing that, an actionable
  // message instead of "Failed to initialize OpenTUI render library".
  const renderLibrarySource = await ensureRenderLibrary({
    resolve: resolveRenderLib,
    setPath: setRenderLibPath,
    embeddedFiles: () => Bun.embeddedFiles,
    cacheDir: () => defaultRenderLibraryCacheDir(getConfigDir()),
    tempDir: () => bunExtractionTempDir(),
  })
  if (renderLibrarySource === 'cache') {
    logger.warn(
      { tempDir: bunExtractionTempDir() },
      'Loaded the terminal renderer from the config directory: the temp directory copy failed',
    )
  }
  // Bun leaves a full copy of the renderer library in the temp directory on
  // every launch; reclaim older ones off the startup path.
  setTimeout(() => {
    const library = findEmbeddedRenderLibrary(Bun.embeddedFiles)
    if (!library) return
    void sweepLeakedRenderLibraryCopies({
      library,
      tempDir: bunExtractionTempDir(),
    })
      .then(({ removed, bytes }) => {
        if (removed > 0) {
          logger.info(
            { removed, bytes },
            'Removed stale renderer library copies from the temp directory',
          )
        }
      })
      .catch(() => {})
  }, 0)

  // Settle gates for the background probe/read, placed AFTER the work they
  // overlap (trust gates, agent registry, renderer library staging) instead
  // of ahead of it. First-consumed ordering, not timing, is what keeps the
  // settled state identical to awaiting both up front:
  //   - The OSC reply is consumed exclusively through oscDetectedTheme and
  //     the resolver is only refreshed once the theme code is live
  //     (initializeApp). A settle that lands before the refresh stores the
  //     value and initializeThemeStore's initial detectSystemTheme() picks
  //     it up — the same detector order the awaited startup resolved with.
  //   - The token's sync readers listed above all fire after this point.
  // A settle arriving late applies through the normal watcher refresh path,
  // unchanged from the awaited startup except that paint went first.
  if (oscThemePromiseSettled) {
    // Fully overlapped (the common case): nothing to wait on.
  } else {
    // The startup work did not cover the deadline: non-TTY runs (the probe
    // resolves without a query, but the settle handler only attaches after
    // parseArgs), pre-trusted registries, or a cached renderer library.
    // There is no rendered frame to surprise the user with yet, so the old
    // pre-paint wait is restored for the remainder of the deadline — over
    // the whole startup the probe never gates paint for longer than
    // GLOBAL_OSC_TIMEOUT_MS, the same bound as before.
    settleOscDetection()
    await oscThemePromise
  }
  // React effects (and with them every token consumer) run post-paint, so
  // the keychain overlap already covers real sessions; this await only fires
  // when startup could not get ahead of the keychain read.
  await storedAuthTokenPromise
  const renderer = await createCliRenderer({
    backgroundColor: 'transparent',
    exitOnCtrlC: false,
    exitSignals: CLI_RENDERER_EXIT_SIGNALS,
    screenMode: 'alternate-screen',
  })
  renderer.once('destroy', restoreAiSdkWarnings)

  // Install the renderer-aware handlers before removing the startup safety net
  // so an installation failure still restores the terminal and reports itself.
  installProcessCleanupHandlers(renderer)
  const terminalProtocols = installTerminalProtocolController(renderer, {
    onError: (error) =>
      logger.debug(error, 'Terminal protocol transition failed'),
  })
  renderer.once('destroy', () => terminalProtocols.dispose())
  process.removeListener('uncaughtException', earlyFatalHandler)
  process.removeListener('unhandledRejection', earlyFatalHandler)

  // Start the engaged-time heartbeat only once the interactive TUI is actually
  // live — reaching renderer creation means this is a real session (the
  // login/publish/smoke-test commands all exit earlier). Freebuff-only, matching
  // the MESSAGE_SENT DAU signal. Stopped in exitCliCleanly().
  if (IS_FREEBUFF) {
    startEngagementTracking()
  }

  createRoot(renderer).render(
    <QueryClientProvider client={queryClient}>
      <AppWithAsyncAuth />
    </QueryClientProvider>,
  )
}

void main()
