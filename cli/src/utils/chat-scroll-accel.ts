import { getCliEnv } from './env'

import type { CliEnv } from '../types/env'
import type { ScrollAcceleration } from '@opentui/core'

const ENVIRONMENT_TYPE_VARS = [
  'TERM_PROGRAM',
  'TERMINAL_EMULATOR',
  'TERM',
  'EDITOR',
  'ZED_TERM',
  'ZED_SHELL',
] as const

const ENVIRONMENTS = ['zed', 'ghostty', 'vscode'] as const

type ScrollEnvironmentType = (typeof ENVIRONMENTS)[number] | 'default'

const ENV_MULTIPLIERS = {
  zed: 0.5,
  ghostty: 1,
  vscode: 1,
  default: 1,
} satisfies Record<ScrollEnvironmentType, number>

type ScrollEnvironment = {
  type: ScrollEnvironmentType
  multiplier: number
}

const resolveScrollEnvironment = (
  env: CliEnv = getCliEnv(),
): ScrollEnvironment => {
  let multiplier = parseFloat(env.CODEBUFF_SCROLL_MULTIPLIER ?? '')

  if (Number.isNaN(multiplier)) {
    multiplier = 1
  }

  for (const hintVar of ENVIRONMENT_TYPE_VARS) {
    const value = env[hintVar]
    for (const environment of ENVIRONMENTS) {
      if (value?.includes(environment)) {
        return { type: environment, multiplier }
      }
    }
  }

  return { type: 'default', multiplier }
}

type ConstantScrollAccelOptions = {
  /** How fast to scale the scrolling. */
  multiplier?: number
}

/** Always scrolls at a constant speed per tick. */
export class ConstantScrollAccel implements ScrollAcceleration {
  private multiplier: number
  private buffer: number

  constructor(private opts: ConstantScrollAccelOptions = {}) {
    this.buffer = 0
    this.multiplier = opts.multiplier ?? 1
  }

  tick(): number {
    this.buffer += this.multiplier
    const rows =
      this.buffer > 0 ? Math.floor(this.buffer) : Math.ceil(this.buffer)
    this.buffer -= rows
    return rows
  }

  reset(): void {
    this.buffer = 0
  }
}

export const createChatScrollAcceleration = (): ScrollAcceleration => {
  const environment = resolveScrollEnvironment()

  return new ConstantScrollAccel({
    multiplier: ENV_MULTIPLIERS[environment.type] * environment.multiplier,
  })
}
