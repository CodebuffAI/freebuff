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
}

export const CLOUD_MISSION_MAX_PASSES = 30
