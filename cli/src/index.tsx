#!/usr/bin/env bun

// Embed tree-sitter.wasm into the bun-compile binary at a bunfs path the runtime
// can find. Without this, web-tree-sitter resolves the wasm via require.resolve,
// which (since 0.25.10's split exports map) returns the build-time absolute path
// of tree-sitter.cjs and fails on user machines. Must run before the SDK / code-map
// import chain triggers Parser.init.
import './pre-init/tree-sitter-wasm'

import fs from 'fs'
import { createRequire } from 'module'
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
import { Command } from 'commander'
import { cyan, green, red, yellow } from 'picocolors'
import React from 'react'

import { App } from './app'
import { handlePublish } from './commands/publish'
import { runPlainLogin } from './login/plain-login'
import { initializeApp } from './init/init-app'
import { getProjectRoot, setProjectRoot } from './project-files'
import { trackEvent } from './utils/analytics'
import { getAuthToken, getAuthTokenDetails } from './utils/auth'
import { resetCodebuffClient } from './utils/codebuff-client'
import { setApiClientAuthToken } from './utils/codebuff-api'
import { IS_FREEBUFF } from './utils/constants'
import { getCliEnv } from './utils/env'
import { initializeAgentRegistry } from './utils/local-agent-registry'
import { clearLogFile, logger } from './utils/logger'
import { shouldShowProjectPicker } from './utils/project-picker'
import { saveRecentProject } from './utils/recent-projects'
import { installProcessCleanupHandlers, TERMINAL_RESET_SEQUENCES } from './utils/renderer-cleanup'
import { initializeSkillRegistry } from './utils/skill-registry'
import { detectTerminalTheme } from './utils/terminal-color-detection'
import { setOscDetectedTheme } from './utils/theme-system'

import type { AgentMode } from './utils/constants'
import type { FileTreeNode } from '@codebuff/common/util/file'

const require = createRequire(import.meta.url)

function loadPackageVersion(): string {
  const env = getCliEnv()
  if (env.CODEBUFF_CLI_VERSION) {
    return env.CODEBUFF_CLI_VERSION
  }

  try {
    const pkg = require('../package.json') as { version?: string }
    if (pkg.version) {
      return pkg.version
    }
  } catch {
    // Continue to dev fallback
  }

  return 'dev'
}

// Configure TanStack Query's focusManager for terminal environments
// This is required because there's no browser visibility API in terminal apps
// Without this, refetchInterval won't work because TanStack Query thinks the app is "unfocused"
focusManager.setEventListener(() => {
  // No-op: no event listeners in CLI environment (no window focus/visibility events)
  return () => { }
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

type ParsedArgs = {
  initialPrompt: string | null
  agent?: string
  clearLogs: boolean
  continue: boolean
  continueId?: string | null
  cwd?: string
  initialMode?: AgentMode
}

function parseArgs(): ParsedArgs {
  const program = new Command()

  if (IS_FREEBUFF) {
    // Freebuff: simplified CLI - no prompt args, no agent override, no clear-logs
    program
      .name('freebuff')
      .description('Freebuff - Free AI coding assistant')
      .version(loadPackageVersion(), '-v, --version', 'Print the CLI version')
      .option(
        '--continue [conversation-id]',
        'Continue from a previous conversation (optionally specify a conversation id)',
      )
      .option(
        '--cwd <directory>',
        'Set the working directory (default: current directory)',
      )
      .addHelpText('after', '\nCommands:\n  login                          Log in to your account')
      .helpOption('-h, --help', 'Show this help message')
      .parse(process.argv)
  } else {
    // Codebuff: full CLI with all options
    program
      .name('codebuff')
      .description('Codebuff CLI - AI-powered coding assistant')
      .version(loadPackageVersion(), '-v, --version', 'Print the CLI version')
      .option(
        '--agent <agent-id>',
        'Run a specific agent id (skips loading local .agents overrides)',
      )
      .option('--clear-logs', 'Remove any existing CLI log files before starting')
      .option(
        '--continue [conversation-id]',
        'Continue from a previous conversation (optionally specify a conversation id)',
      )
      .option(
        '--cwd <directory>',
        'Set the working directory (default: current directory)',
      )
      .option('--lite', 'Start in LITE mode')
      .option('--free', 'Start in LITE mode (deprecated alias)')
      .option('--max', 'Start in MAX mode')
      .option('--plan', 'Start in PLAN mode')
      .addHelpText('after', '\nCommands:\n  login                          Log in to your account\n  publish                        Publish agents to the registry')
      .helpOption('-h, --help', 'Show this help message')
      .argument('[prompt...]', 'Initial prompt to send to the agent')
      .allowExcessArguments(true)
      .parse(process.argv)
  }

  const options = program.opts()
  const args = program.args

  const continueFlag = options.continue

  // Determine initial mode from flags (last flag wins if multiple specified)
  // Freebuff always uses LITE mode
  let initialMode: AgentMode | undefined
  if (IS_FREEBUFF) {
    initialMode = 'LITE'
  } else {
    if (options.free || options.lite) initialMode = 'LITE'
    if (options.max) initialMode = 'MAX'
    if (options.plan) initialMode = 'PLAN'
  }

  return {
    initialPrompt: args.length > 0 ? args.join(' ') : null,
    agent: options.agent,
    clearLogs: options.clearLogs || false,
    continue: Boolean(continueFlag),
    continueId:
      typeof continueFlag === 'string' && continueFlag.trim().length > 0
        ? continueFlag.trim()
        : null,
    cwd: options.cwd,
    initialMode,
  }
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
      dirListing = [`<readdir failed: ${err instanceof Error ? err.message : err}>`]
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

  // CI gate: `<binary> --smoke-login-primitives` checks the local pieces that
  // must work before browser OAuth can complete. This is intentionally not a
  // full OAuth flow: CI should not depend on a real GitHub account/browser
  // round trip just to validate the compiled Windows executable.
  if (process.argv.includes('--smoke-login-primitives')) {
    try {
      const [{ withTimeout }, fingerprint, { getWindowsOpenUrlCommand }] =
        await Promise.all([
          import('@codebuff/common/util/promise'),
          import('./utils/fingerprint'),
          import('./utils/open-url'),
        ])

      let timeoutRejected = false
      try {
        await withTimeout(
          new Promise<never>(() => {}),
          50,
          'login smoke expected timeout',
        )
      } catch (err) {
        timeoutRejected =
          err instanceof Error &&
          err.message.includes('login smoke expected timeout')
      }
      if (!timeoutRejected) {
        throw new Error('withTimeout did not reject a hanging promise')
      }

      const fingerprintId = await withTimeout(
        fingerprint.calculateFingerprint(),
        5_000,
        'calculateFingerprint exceeded login smoke timeout',
      )
      const fingerprintType = fingerprint.getFingerprintType(fingerprintId)
      if (fingerprintType === 'unknown') {
        throw new Error(`Unexpected fingerprint type for ${fingerprintId}`)
      }

      if (process.platform === 'win32') {
        const opener = getWindowsOpenUrlCommand('https://example.com')
        if (
          opener.command !== 'rundll32.exe' ||
          opener.args[0] !== 'url.dll,FileProtocolHandler' ||
          opener.args[1] !== 'https://example.com'
        ) {
          throw new Error(
            `Unexpected Windows URL opener: ${opener.command} ${opener.args.join(' ')}`,
          )
        }
      }

      console.log(`login primitives smoke ok (${fingerprintType})`)
      process.exit(0)
    } catch (err) {
      console.error('login primitives smoke FAIL:', err)
      process.exit(1)
    }
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
    agent,
    clearLogs,
    continue: continueChat,
    continueId,
    cwd,
    initialMode,
  } = parseArgs()

  const isLoginCommand = process.argv[2] === 'login'
  const isPublishCommand = process.argv[2] === 'publish'
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
  const earlyFatalHandler = (error: unknown) => {
    try {
      if (process.stdin.isTTY && process.stdin.setRawMode) {
        process.stdin.setRawMode(false)
      }
    } catch {
      // stdin may be closed
    }
    try {
      if (process.stdout.isTTY) {
        process.stdout.write(TERMINAL_RESET_SEQUENCES)
      }
    } catch {
      // stdout may be closed
    }
    try {
      console.error('Fatal error during startup:', error)
    } catch {
      // stderr may be closed
    }
    process.exit(1)
  }
  process.on('uncaughtException', earlyFatalHandler)
  process.on('unhandledRejection', earlyFatalHandler)

  const renderer = await createCliRenderer({
    backgroundColor: 'transparent',
    exitOnCtrlC: false,
    screenMode: 'alternate-screen',
  })

  // Remove early handlers — proper cleanup handlers (with renderer access) take over
  process.removeListener('uncaughtException', earlyFatalHandler)
  process.removeListener('unhandledRejection', earlyFatalHandler)
  installProcessCleanupHandlers(renderer)
  createRoot(renderer).render(
    <QueryClientProvider client={queryClient}>
      <AppWithAsyncAuth />
    </QueryClientProvider>,
  )
}

void main()
