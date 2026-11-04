import { z } from 'zod/v4'
import { deviceExecutionTarget } from './device-execution'

/** Display-only discovery. Every send rechecks project ownership and the exact folder. */
export const remoteDevice = z.object({
  deviceId: z.string().uuid(),
  name: z.string().min(1).max(240),
  platform: z.enum(['darwin', 'linux', 'win32']),
  target: deviceExecutionTarget,
})
export type RemoteDevice = z.infer<typeof remoteDevice>
export const projectRemoteDevices = z.object({
  synced: z.boolean(),
  devices: z.array(remoteDevice).max(17),
})
export type ProjectRemoteDevices = z.infer<typeof projectRemoteDevices>
