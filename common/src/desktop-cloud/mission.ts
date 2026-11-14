import { z } from 'zod/v4'

/** A mission belongs to a coding project chat and runs on its existing session. */
export const cloudMissionInputSchema = z
  .object({
    prompt: z.string().trim().min(1).max(4_000),
    effort: z.union([
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(4),
      z.literal(5),
    ]),
  })
  .strict()

export type CloudMissionInput = z.infer<typeof cloudMissionInputSchema>
export const cloudMissionUpdateSchema = cloudMissionInputSchema
  .partial()
  .extend({
    on: z.boolean().optional(),
    /** Send now interrupts the current turn while retaining the mission. */
    interrupt: z.literal(true).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Choose a mission change')
  .refine(
    (value) => !value.interrupt || Object.keys(value).length === 1,
    'Interrupt cannot be combined with mission settings',
  )
export type CloudMissionUpdate = z.infer<typeof cloudMissionUpdateSchema>

/** Durable campaign state, shared by Desktop and the browser workspace. */
export type CloudMission = CloudMissionInput & {
  on: boolean
  revision: number
  passCount: number
  status: 'running' | 'deciding' | 'stopped'
  note?: string
  /** Only this cancellation may preserve the enabled mission for a steering message. */
  interruptedRunId?: string
  /** What the decider sent earlier in this campaign; a human send starts a new one. */
  history?: CloudMissionMemory[]
}

export const CLOUD_MISSION_MAX_PASSES = 30

/** One automatic pass, as the next decision reads it. */
export type CloudMissionMemory = {
  pass: number
  outcome: string
  doneWhen: string
  why: string
}

/** The decider reads this on every call, so its size is a per-decision cost. */
export const CLOUD_MISSION_MEMORY_LIMIT = 8
const MEMORY_OUTCOME_MAX = 200
const MEMORY_LINE_MAX = 120

const memoryText = (text: string, max: number) => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

/** Append one pass, keeping the newest entries and a bounded size per entry. */
export function rememberMissionPass(
  history: readonly CloudMissionMemory[] | undefined,
  pass: CloudMissionMemory,
): CloudMissionMemory[] {
  return [
    ...(history ?? []),
    {
      pass: pass.pass,
      outcome: memoryText(pass.outcome, MEMORY_OUTCOME_MAX),
      doneWhen: memoryText(pass.doneWhen, MEMORY_LINE_MAX),
      why: memoryText(pass.why, MEMORY_LINE_MAX),
    },
  ].slice(-CLOUD_MISSION_MEMORY_LIMIT)
}
