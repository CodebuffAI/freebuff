import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'

/**
 * Check if tmux is available and usable on the system.
 * This checks both that tmux is installed AND that it can actually run
 * (e.g., the tmux server socket directory exists and is accessible).
 *
 * Returns false on CI unless CODEBUFF_RUN_TMUX_TESTS=1 explicitly opts into
 * running deterministic tmux tests in a known terminal environment.
 */
export function isTmuxAvailable(): boolean {
  // Skip on CI - tmux integration tests need a real terminal environment
  if (
    (process.env.CI === 'true' || process.env.CI === '1') &&
    process.env.CODEBUFF_RUN_TMUX_TESTS !== '1'
  ) {
    return false
  }

  try {
    // First check if tmux is installed
    execSync('which tmux', { stdio: 'pipe' })
    // Then verify tmux can actually run by creating and killing a test session
    // This will fail if tmux server can't start (e.g., no socket directory on CI)
    execSync('tmux new-session -d -s __codebuff_tmux_check__ && tmux kill-session -t __codebuff_tmux_check__', {
      stdio: 'pipe',
      timeout: 5000,
    })
    return true
  } catch {
    return false
  }
}

/**
 * Check if the SDK is built by checking for the dist directory
 */
export function isSDKBuilt(): boolean {
  try {
    const sdkDistDir = path.join(__dirname, '../../../sdk/dist')
    const possibleArtifacts = ['index.js', 'index.mjs', 'index.cjs']
    return possibleArtifacts.some((file) =>
      fs.existsSync(path.join(sdkDistDir, file)),
    )
  } catch {
    return false
  }
}

/**
 * Sleep utility for async delays
 */
export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms))

let cachedEnv: Record<string, string> | null = null

const TEST_CLIENT_ENV_DEFAULTS: Record<string, string> = {
  NEXT_PUBLIC_CB_ENVIRONMENT: 'test',
  NEXT_PUBLIC_CODEBUFF_APP_URL: 'http://localhost:3000',
  NEXT_PUBLIC_SUPPORT_EMAIL: 'support@codebuff.com',
  NEXT_PUBLIC_POSTHOG_API_KEY: 'test-posthog-key',
  NEXT_PUBLIC_POSTHOG_HOST_URL: 'https://us.i.posthog.com',
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_placeholder',
  NEXT_PUBLIC_STRIPE_CUSTOMER_PORTAL:
    'https://billing.stripe.com/p/login/test_placeholder',
  NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION_ID: 'test-verification',
  NEXT_PUBLIC_WEB_PORT: '3000',
}
const TEST_SERVER_ENV_DEFAULTS: Record<string, string> = {
  OPEN_ROUTER_API_KEY: 'test',
  OPENAI_API_KEY: 'test',
  ANTHROPIC_API_KEY: 'test',
  SERPER_API_KEY: 'test',
  GRAVITY_API_KEY: 'test',
  GRAVITY_CAPI_KEY: 'test',
  PORT: '4242',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
  CODEBUFF_GITHUB_ID: 'test-id',
  CODEBUFF_GITHUB_SECRET: 'test-secret',
  NEXTAUTH_SECRET: 'test-secret',
  STRIPE_SECRET_KEY: 'sk_test_dummy',
  STRIPE_WEBHOOK_SECRET_KEY: 'whsec_dummy',
  STRIPE_TEAM_FEE_PRICE_ID: 'price_test',
  LOOPS_API_KEY: 'test',
  DISCORD_PUBLIC_KEY: 'test',
  DISCORD_BOT_TOKEN: 'test',
  DISCORD_APPLICATION_ID: 'test',
}

function ensureCliEnvDefaults(): void {
  if (!process.env.NODE_ENV) {
    process.env.NODE_ENV = 'test'
  }
  if (!process.env.BUN_ENV) {
    process.env.BUN_ENV = 'test'
  }
  if (process.env.CI !== 'true' && process.env.CI !== '1') {
    process.env.CI = 'true'
  }

  for (const [key, value] of Object.entries(TEST_CLIENT_ENV_DEFAULTS)) {
    if (!process.env[key]) {
      process.env[key] = value
    }
  }

  for (const [key, value] of Object.entries(TEST_SERVER_ENV_DEFAULTS)) {
    if (!process.env[key]) {
      process.env[key] = value
    }
  }
}

function loadCliEnv(): Record<string, string> {
  if (cachedEnv) {
    return cachedEnv
  }

  try {
    ensureCliEnvDefaults()
    try {
      const { env } = require('../../../packages/internal/src/env') as {
        env: Record<string, unknown>
      }

      cachedEnv = Object.entries(env).reduce<Record<string, string>>(
        (acc, [key, value]) => {
          if (value !== undefined && value !== null) {
            acc[key] = String(value)
          }
          return acc
        },
        {},
      )

      return cachedEnv
    } catch {
      // Fallback for public mirror where packages/internal is not present
      cachedEnv = {
        ...TEST_CLIENT_ENV_DEFAULTS,
        ...TEST_SERVER_ENV_DEFAULTS,
      }
      return cachedEnv
    }
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'unknown error loading environment'
    throw new Error(
      `Failed to load CLI environment via packages/internal/src/env: ${message}. ` +
        'Run commands via "infisical run -- bun …" or export the required variables.',
    )
  }
}

export function ensureCliTestEnv(): void {
  loadCliEnv()
}

export function getDefaultCliEnv(): Record<string, string> {
  return { ...loadCliEnv() }
}

/**
 * Parsed re-render log entry from useWhyDidYouUpdate hook
 */
export interface RerenderLogEntry {
  timestamp: string
  componentName: string
  messageId: string
  renderCount: number
  changedProps: string[]
}

/**
 * Aggregated re-render analysis results
 */
export interface RerenderAnalysis {
  totalRerenders: number
  rerendersByMessage: Map<string, number>
  propChangeFrequency: Map<string, number>
  maxRerenderPerMessage: number
}

/**
 * Parse re-render logs from the CLI debug log file
 */
export function parseRerenderLogs(logPath: string): RerenderLogEntry[] {
  const entries: RerenderLogEntry[] = []

  try {
    const content = fs.readFileSync(logPath, 'utf-8')
    const lines = content.split('\n').filter((line) => line.trim())

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line)

        // Check if this is a re-render log entry
        if (
          parsed.msg &&
          typeof parsed.msg === 'string' &&
          parsed.msg.includes('render #')
        ) {
          // Extract component name from msg like "MessageBlock render #2 [user-123]: 2 props changed"
          const msgMatch = parsed.msg.match(
            /^(\w+) render #(\d+) \[([^\]]+)\]/,
          )
          if (msgMatch && parsed.data) {
            entries.push({
              timestamp: parsed.timestamp,
              componentName: msgMatch[1],
              messageId: parsed.data.id || msgMatch[3],
              renderCount: parseInt(msgMatch[2], 10),
              changedProps: parsed.data.changedProps || [],
            })
          }
        }
      } catch {
        // Skip malformed lines
      }
    }
  } catch {
    // File doesn't exist or can't be read
  }

  return entries
}

/**
 * Analyze re-render logs and return aggregated statistics
 */
export function analyzeRerenders(entries: RerenderLogEntry[]): RerenderAnalysis {
  const rerendersByMessage = new Map<string, number>()
  const propChangeFrequency = new Map<string, number>()

  for (const entry of entries) {
    // Count re-renders per message
    const currentCount = rerendersByMessage.get(entry.messageId) || 0
    rerendersByMessage.set(entry.messageId, currentCount + 1)

    // Count how often each prop changes
    for (const prop of entry.changedProps) {
      const propCount = propChangeFrequency.get(prop) || 0
      propChangeFrequency.set(prop, propCount + 1)
    }
  }

  // Find max re-renders for any single message
  let maxRerenderPerMessage = 0
  for (const count of rerendersByMessage.values()) {
    if (count > maxRerenderPerMessage) {
      maxRerenderPerMessage = count
    }
  }

  return {
    totalRerenders: entries.length,
    rerendersByMessage,
    propChangeFrequency,
    maxRerenderPerMessage,
  }
}

/**
 * Clear the CLI debug log file
 */
export function clearCliDebugLog(logPath: string): void {
  try {
    fs.writeFileSync(logPath, '')
  } catch {
    // Ignore errors
  }
}
