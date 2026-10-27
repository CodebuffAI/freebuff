import { z } from 'zod/v4'
import { devicePanelOperation } from './device-panels'

/** V1 stays read-only. V2 execution requires an explicit local opt-in. */
export const DEVICE_EXECUTION_VERSION = 1
export const DEVICE_READ_BYTES = 64 * 1024
export const DEVICE_DIRECTORY_ENTRIES = 100
export const DEVICE_OPERATION_MS = 25_000
export const DEVICE_HEARTBEAT_MS = 10_000
export const DEVICE_SESSION_SECONDS = 60
export const DEVICE_FRAME_BYTES = 512 * 1024
export const DEVICE_EXEC_OUTPUT_BYTES = 16 * 1024 * 1024
export const DEVICE_EXEC_FRAME_BYTES = 24 * 1024 * 1024
export const DEVICE_EXEC_MS = 5 * 60_000
export const deviceExecutionTarget = z
  .object({
    sessionId: z.string().uuid(),
    bindingId: z.string().uuid(),
  })
  .strict()
export type DeviceExecutionTarget = z.infer<typeof deviceExecutionTarget>
export const deviceExecutionContext = z
  .object({
    platform: z.enum(['darwin', 'linux', 'win32']),
    nativeTools: z.boolean().optional(),
    panelProtocolVersion: z.literal(1).optional(),
    nativeHarnesses: z.boolean().optional(),
    cwd: z.string().min(1).max(4096),
    rg: z.string().max(4096),
  })
  .strict()
export const deviceExecRequest = z
  .object({
    method: z.literal('exec'),
    command: z.string().min(1).max(200_000),
    outputLimit: z.number().int().min(1).max(DEVICE_EXEC_OUTPUT_BYTES),
  })
  .strict()
export const deviceExecResult = z
  .object({
    kind: z.literal('exec'),
    stdout: z.string().max(DEVICE_EXEC_OUTPUT_BYTES),
    stderr: z.string().max(DEVICE_EXEC_OUTPUT_BYTES),
    statusCode: z.number().int(),
  })
  .strict()
export const deviceIdSchema = z.string().uuid()
export const deviceRelativePath = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (path) =>
      !path.startsWith('/') &&
      !path.includes('\\') &&
      !path.includes(':') &&
      !path.includes('\0') &&
      !path.split('/').some((part) => part === '..' || part.startsWith('.')),
    'Use a workspace-relative path without hidden files or traversal',
  )
export const deviceReadRequest = z.discriminatedUnion('method', [
  z
    .object({ method: z.literal('read_file'), path: deviceRelativePath })
    .strict(),
  z
    .object({
      method: z.literal('list_directory'),
      path: deviceRelativePath.optional(),
    })
    .strict(),
])
export type DeviceReadRequest = z.infer<typeof deviceReadRequest>
export const deviceReadResult = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('file'),
      text: z.string().max(DEVICE_READ_BYTES),
      truncated: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('directory'),
      entries: z
        .array(
          z
            .object({
              name: z.string().max(1024),
              kind: z.enum(['file', 'directory']),
            })
            .strict(),
        )
        .max(DEVICE_DIRECTORY_ENTRIES),
      truncated: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('error'),
      code: z.enum(['unavailable', 'refused']),
    })
    .strict(),
])
export type DeviceReadResult = z.infer<typeof deviceReadResult>
export const deviceToolScope = z
  .object({
    workspaceId: z.string().min(1).max(200),
    runId: z.string().min(1).max(200),
    mode: z.enum(['plan', 'build']),
    referencedThreadIds: z
      .array(z.string().min(1).max(120))
      .max(100)
      .optional(),
  })
  .strict()
export const deviceToolRequest = z
  .object({
    method: z.literal('tool'),
    scope: deviceToolScope,
    name: z.string().min(1).max(200),
    callId: z.string().min(1).max(200).optional(),
    input: z.unknown(),
  })
  .strict()
export const deviceManifestRequest = z
  .object({
    method: z.literal('manifest'),
    scope: deviceToolScope,
  })
  .strict()
export const deviceToolFailure = z
  .object({ kind: z.literal('tool_error'), message: z.string().max(4000) })
  .strict()
export const deviceProgress = z
  .object({
    id: deviceIdSchema,
    sequence: z.number().int().positive(),
    value: z.unknown(),
  })
  .strict()
export const deviceReceiptRequest = z
  .object({
    method: z.literal('receipt'),
    scope: deviceToolScope,
    operationId: deviceIdSchema,
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
export const deviceSteeringMessage = z
  .object({ id: deviceIdSchema, prompt: z.string().min(1).max(200_000) })
  .strict()
export const deviceHarnessRequest = z.discriminatedUnion('method', [
  z
    .object({
      method: z.literal('harness_steer'),
      scope: deviceToolScope,
      message: deviceSteeringMessage,
    })
    .strict(),
  z
    .object({
      method: z.literal('harness_start'),
      scope: deviceToolScope,
      harness: z.enum(['codex', 'claude-code']),
      prompt: z.string().min(1).max(200_000),
      model: z.string().max(200),
      effort: z
        .enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
        .optional(),
      images: z
        .array(
          z.object({
            data: z.string().max(16_000_000),
            mediaType: z.string().max(100),
          }),
        )
        .max(10)
        .optional(),
      previousState: z.unknown().optional(),
      /** A completed runtime transfer must not resume a session from another machine. */
      resetSession: z.boolean().optional(),
      importedHistory: z.string().max(20 * 1024 * 1024).optional(),
      /** Quoted history used only when neither Cloud nor Desktop has a CLI session. */
      initialPrompt: z.string().max(2 * 1024 * 1024).optional(),
      documents: z
        .array(
          z
            .object({
              name: z.string().max(1024),
              text: z.string().max(1_000_000),
            })
            .strict(),
        )
        .max(12)
        .optional(),
      injectAgentsMd: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal('harness_answer'),
      scope: deviceToolScope,
      questionId: deviceIdSchema,
      answer: z.unknown(),
    })
    .strict(),
  z
    .object({ method: z.literal('harness_status'), scope: deviceToolScope })
    .strict(),
  z
    .object({
      method: z.literal('harness_read'),
      scope: deviceToolScope,
      cursor: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({ method: z.literal('harness_stop'), scope: deviceToolScope })
    .strict(),
])
export const deviceHarnessPage = z
  .object({
    events: z.array(
      z.object({
        kind: z.string(),
        payload: z.unknown(),
        cursor: z.number().int().positive(),
      }),
    ),
    cursor: z.number().int().nonnegative(),
    done: z.boolean(),
  })
  .strict()
export const deviceValueResult = z
  .object({
    kind: z.literal('value'),
    value: z.unknown(),
    changes: z.array(z.unknown()).max(2000).optional(),
  })
  .strict()
export const deviceRequest = z.union([
  deviceReadRequest,
  deviceExecRequest,
  deviceToolRequest,
  deviceManifestRequest,
  deviceHarnessRequest,
  deviceReceiptRequest,
])
export const deviceResult = z.union([
  deviceReadResult,
  deviceExecResult,
  deviceValueResult,
  deviceToolFailure,
])
export type DeviceToolScope = z.infer<typeof deviceToolScope>
export type DeviceRequest = z.infer<typeof deviceRequest>
export type DeviceResult = z.infer<typeof deviceResult>
export const deviceRegistration = z
  .object({
    protocolVersion: z.literal(DEVICE_EXECUTION_VERSION),
    deviceId: deviceIdSchema,
    bindingId: deviceIdSchema,
  })
  .strict()
export const deviceExecutionRegistration = z
  .object({
    protocolVersion: z.literal(2),
    deviceId: deviceIdSchema,
    bindingId: deviceIdSchema,
    context: deviceExecutionContext,
  })
  .strict()
export const deviceNativeRegistration = deviceExecutionRegistration.extend({
  protocolVersion: z.literal(3),
  context: deviceExecutionContext.extend({ nativeTools: z.literal(true) }),
})
export const deviceSession = z
  .object({
    sessionId: deviceIdSchema,
    token: z.string().min(32).max(128),
  })
  .strict()
export type DeviceSession = z.infer<typeof deviceSession>
export const deviceOperation = z
  .object({
    id: deviceIdSchema,
    sessionId: deviceIdSchema,
    bindingId: deviceIdSchema,
    expiresAt: z.number().int(),
    request: deviceRequest,
  })
  .strict()
export type DeviceOperation = z.infer<typeof deviceOperation>
export const deviceReply = z
  .object({ id: deviceIdSchema, result: deviceResult })
  .strict()
export const deviceFrame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('panel'), operation: devicePanelOperation }).strict(),
  z.object({ type: z.literal('cancel'), id: deviceIdSchema }).strict(),
  z.object({ type: z.literal('ready') }).strict(),
  z.object({ type: z.literal('heartbeat') }).strict(),
  z
    .object({ type: z.literal('operation'), operation: deviceOperation })
    .strict(),
])
export const deviceCapabilities = z
  .object({
    enabled: z.boolean(),
    protocolVersion: z.literal(DEVICE_EXECUTION_VERSION),
    methods: z.array(z.enum(['read_file', 'list_directory'])),
    executionProtocolVersion: z.literal(2).optional(),
    nativeProtocolVersion: z.literal(3).optional(),
    panelProtocolVersion: z.literal(1).optional(),
  })
  .strict()

/** Deterministic UUID-shaped identity from a SHA-256 digest; never a credential. */
export function deviceIdentity(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}
