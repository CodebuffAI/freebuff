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
import { createCliRenderer } from '@opentui/core'
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
import { getAuthToken, getAuthTokenDetails } from './utils/auth'
import { resetCodebuffClient } from './utils/codebuff-client'
import { setApiClientAuthToken } from './utils/codebuff-api'
import { IS_FREEBUFF } from './utils/constants'
import { initializeAgentRegistry } from './utils/local-agent-registry'
import { trimOversizedChatLogs } from './utils/chat-history'
import { clearLogFile, logger } from './utils/logger'
import { drainClientLogs } from './utils/log-shipper'
import { shouldShowProjectPicker } from './utils/project-picker'
import { saveRecentProject } from './utils/recent-projects'
import { startEngagementTracking } from './utils/engagement'
import {
  exitCliWithFatalError,
  installProcessCleanupHandlers,
} from './utils/renderer-cleanup'
import { startRunActivityMarker } from './utils/run-activity-marker'
import { startTerminalWatchdog } from './utils/terminal-watchdog'
import { installTerminalProtocolController } from './utils/terminal-protocol-controller'
import { initializeSkillRegistry } from './utils/skill-registry'
import { detectTerminalTheme } from './utils/terminal-color-detection'
import { setOscDetectedTheme } from './utils/theme-system'

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

  // Run OSC theme detection BEFORE anything else.
  // This MUST happen before OpenTUI starts because OSC responses come through stdin,
  // and OpenTUI also listens to stdin. Running detection here ensures stdin is clean.
  if (process.stdin.isTTY && process.platform !== 'win32') {
    try {
      const oscTheme = await detectTerminalTheme()
      if (oscTheme) {
        setOscDetectedTheme(oscTheme)
      }
    } catch {
      // Silently ignore OSC detection failures
    }
  }

  const {
    initialPrompt,
    command,
    agent,
    clearLogs,
    continue: continueChat,
    continueId,
    cwd,
    initialMode,
  } = parseArgs()

  const isLoginCommand = command === 'login'
  const isPublishCommand = command === 'publish'
  const hasAgentOverride = Boolean(agent?.trim())

  await initializeApp({ cwd })

  // Set the auth token for the API client
  setApiClientAuthToken(getAuthToken())

  // Handle login command before rendering the app
  if (isLoginCommand) {
    await runPlainLogin()
    return
  }

  // Show project picker only when user starts at the home directory or an ancestor
  const projectRoot = getProjectRoot()
  const homeDir = os.homedir()
  const startCwd = process.cwd()
  const showProjectPicker = shouldShowProjectPicker(startCwd, homeDir)

  // Requires analytics to be initialized, which is done in initializeApp
  trackEvent(AnalyticsEvent.APP_LAUNCHED, {
    version: loadPackageVersion(),
    platform: process.platform,
    arch: process.arch,
    hasInitialPrompt: Boolean(initialPrompt),
    hasAgentOverride: hasAgentOverride,
    continueChat,
    initialMode: initialMode ?? 'DEFAULT',
    isFreeBuff: IS_FREEBUFF,
  })
  // Start shipping the launch row now, well before the Windows watchdog is
  // armed. If endpoint security terminates this process during that spawn, the
  // next --continue launch still has a prior row for the health dashboard's
  // rapid-resume and interruption joins.
  if (IS_FREEBUFF && process.platform === 'win32') {
    void drainClientLogs()
  }

  // Initialize agent registry (loads user agents via SDK).
  // When --agent is provided, skip local .agents to avoid overrides.
  if (isPublishCommand || !hasAgentOverride) {
    await initializeAgentRegistry()
  }

  // Initialize skill registry (loads skills from .agents/skills)
  await initializeSkillRegistry()

  // Handle publish command before rendering the app
  if (isPublishCommand) {
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

  // Lets the npm-wrapper launcher defer an auto-update restart until any
  // in-progress turn finishes, instead of interrupting it. Started early so
  // no isChainInProgress transition can slip by before the subscription
  // exists.
  startRunActivityMarker()

  const renderer = await createCliRenderer({
    backgroundColor: 'transparent',
    exitOnCtrlC: false,
    screenMode: 'alternate-screen',
  })

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
