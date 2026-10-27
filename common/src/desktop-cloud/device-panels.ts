import { z } from 'zod/v4'

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/)
const scope = { projectId: id, threadId: id }
const path = z.string().max(4096)
const dimensions = { cols: z.number().int().min(2).max(500), rows: z.number().int().min(1).max(200) }
const terminal = { ...scope, sessionId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/) }
const viewer = { ...terminal, viewerId: z.string().uuid() }
const generation = { ...viewer, generation: z.string().min(1).max(128) }

/** Selectors only. The server derives ownership and binding; the device resolves paths. */
export const devicePanelRequest = z.discriminatedUnion('panel', [
  z.object({ panel: z.literal('files'), input: z.discriminatedUnion('operation', [
    z.object({ ...scope, operation: z.literal('list'), directory: path.optional(), query: z.string().max(512).optional() }).strict(),
    z.object({ ...scope, operation: z.literal('read'), path, expanded: z.boolean() }).strict(),
    z.object({ ...scope, operation: z.literal('save'), path, content: z.string().max(512 * 1024), revision: z.string().regex(/^[a-f0-9]{40,64}$/) }).strict(),
    z.object({ ...scope, operation: z.literal('create'), path, kind: z.enum(['file', 'directory']) }).strict(),
  ]) }).strict(),
  z.object({ panel: z.literal('git'), input: z.discriminatedUnion('operation', [
    z.object({ ...scope, operation: z.literal('changes'), scope: z.enum(['all', 'uncommitted']) }).strict(),
    z.object({ ...scope, operation: z.literal('diff'), scope: z.enum(['all', 'uncommitted']), path, untracked: z.boolean() }).strict(),
  ]) }).strict(),
  z.object({ panel: z.literal('terminal'), input: z.discriminatedUnion('operation', [
    z.object({ ...terminal, operation: z.literal('attach'), cols: dimensions.cols.optional(), rows: dimensions.rows.optional(),
      resumeGeneration: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).optional() }).strict(),
    z.object({ ...viewer, operation: z.literal('read') }).strict(),
    z.object({ ...viewer, operation: z.literal('detach') }).strict(),
    z.object({ ...generation, operation: z.literal('input'), data: z.string().max(16 * 1024) }).strict(),
    z.object({ ...generation, ...dimensions, operation: z.literal('resize') }).strict(),
    z.object({ ...terminal, operation: z.literal('close') }).strict(),
  ]) }).strict(),
])
export type DevicePanelRequest = z.infer<typeof devicePanelRequest>
export const DEVICE_PANEL_MS = 25_000
export const DEVICE_PANEL_LIMIT = 32
export const DEVICE_PANEL_BYTES = 4 * 1024 * 1024
export const devicePanelOperation = z.object({
  id: z.string().uuid(), sessionId: z.string().uuid(), bindingId: z.string().uuid(),
  expiresAt: z.number().int(), request: devicePanelRequest,
}).strict()
export type DevicePanelOperation = z.infer<typeof devicePanelOperation>
export const devicePanelResult = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: z.unknown() }).strict(),
  z.object({ ok: z.literal(false), error: z.string().max(4000) }).strict(),
])
export type DevicePanelResult = z.infer<typeof devicePanelResult>
