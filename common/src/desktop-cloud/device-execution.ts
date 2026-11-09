import { z } from 'zod/v4'
import {
  SPONSORED_WINDOWS_CONTAINMENT,
  SPONSORED_WINDOWS_EXECUTION_SURFACE,
} from '../ads/sponsored-windows'
import { devicePanelOperation } from './device-panels'
import { deviceGitHubRequest } from './device-github'

/** V1 stays read-only. V2 execution requires an explicit local opt-in. */
export const DEVICE_EXECUTION_VERSION = 1
export const DEVICE_READ_BYTES = 64 * 1024
export const DEVICE_DIRECTORY_ENTRIES = 100
export const DEVICE_OPERATION_MS = 25_000
export const DEVICE_HEARTBEAT_MS = 10_000
/**
 * How long a folder's enrollment outlives its last heartbeat (server only: Desktop does not read
 * it). Until then a turn reads it `reconnecting` and waits 45 s for it, not 15 s, and its stream
 * reconnects without re-registering. Desktop's bridge gives up after five failed reconnects
 * (~23 s) and then retries an approved folder every 30 s; at 60 s most of those retries came
 * back to a `gone` session.
 */
export const DEVICE_SESSION_SECONDS = 180
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
    displayName: z.string().trim().min(1).max(200).optional(),
    nativeTools: z.boolean().optional(),
    panelProtocolVersion: z.literal(1).optional(),
    nativeHarnesses: z.boolean().optional(),
    concurrentHarnesses: z.literal(true).optional(),
    /** Answers `move_export`: another of the account's computers can take over this folder's chats. */
    deviceMove: z.literal(true).optional(),
    /** Answers `agentic_offer_facts`: Cloud may ask the agentic offer route after this folder's turns. */
    agenticOffers: z.literal(true).optional(),
    /** Answers `sponsored_exec`: Cloud's sponsored agent may run its commands here, contained. */
    sponsoredExec: z.literal(true).optional(),
    /** Honours `scope.warmup`: a new Cloud chat's first turn runs here read-only while it moves (warmup.ts). */
    readOnlyOpener: z.literal(true).optional(),
    githubConnect: z.literal(true).optional(),
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
    /**
     * A Cloud chat's warm-up (warmup.ts): only tools that change nothing run, and the rest answer
     * WARMUP_REFUSAL. Sent only to a device whose context has `readOnlyOpener`.
     */
    warmup: z.literal(true).optional(),
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
/** A chat's Git state for another of the account's computers (docs/desktop/device-execution.md, "Moving a chat to another computer"). */
export const deviceMoveExportRequest = z
  .object({
    method: z.literal('move_export'),
    workspaceId: z.string().min(1).max(200),
    /** Commits the receiving computer has; the bundle leaves out what they reach. */
    have: z.array(z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/)).max(256),
  })
  .strict()
/** `move_export`'s value: the uploaded archive (a source upload), never the bytes. */
export const deviceMoveExport = z
  .object({
    uploadId: z.string().uuid(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().positive(),
  })
  .strict()
export type DeviceMoveExport = z.infer<typeof deviceMoveExport>
export type DeviceMoveExportRequest = z.infer<typeof deviceMoveExportRequest>
/**
 * The folder's agentic offer facts, as Desktop sent them with its own offer request (capability,
 * fit facts, OS); its value is read with `deviceAgenticOfferFactsSchema`. Read-only, never journaled.
 */
export const deviceAgenticOfferFactsRequest = z
  .object({ method: z.literal('agentic_offer_facts') })
  .strict()
/**
 * The funded Accept's Windows floor grant (COD-1335), relayed by Cloud: the
 * only grant that selects the floor broker on a Windows computer
 * (`sponsoredBrokerArm`). Absent on every macOS and Linux run.
 */
export const deviceSponsoredExecGrant = z
  .object({
    executionSurface: z.literal(SPONSORED_WINDOWS_EXECUTION_SURFACE),
    containment: z.literal(SPONSORED_WINDOWS_CONTAINMENT),
  })
  .strict()
export type DeviceSponsoredExecGrant = z.infer<typeof deviceSponsoredExecGrant>
/**
 * One command of an accepted sponsored run, run CONTAINED in the folder: the
 * sponsored sandbox (sandbox-exec on macOS, bwrap on Linux), a private runtime
 * directory for `runId` and read-only Git, never the plain `exec` shell. It has
 * side effects, so it is journaled; its result is `deviceExecResult`'s shape.
 *
 * On Windows (COD-1335) there is no sandbox: the run's commands get the floor
 * (PowerShell 5.1, a scrubbed environment, the private runtime directory)
 * only with `grant`, and `timeoutSeconds` bounds the command's whole process
 * tree on the computer (exit 124), since PowerShell has no `timeout`. Both
 * ride only a floor run's request: an older Desktop parses this strictly.
 */
/**
 * A Windows floor command's time limit when Cloud names none (COD-1335), and
 * the one `cloud_sandbox_exec` names: under the device's own operation cap
 * ({@link DEVICE_EXEC_MS}), so the computer ends the command's whole job and
 * answers 124 before the operation itself times out. Without it, a command
 * that backgrounds a process (a dev server, a watcher, `Start-Process`)
 * would hold the Job Object owner, which waits for the whole job, until the cap.
 */
export const DEVICE_SPONSORED_FLOOR_TIMEOUT_SECONDS = 290
export const deviceSponsoredExecRequest = z
  .object({
    method: z.literal('sponsored_exec'),
    scope: deviceToolScope,
    runId: z.string().uuid(),
    command: z.string().min(1).max(200_000),
    outputLimit: z.number().int().min(1).max(DEVICE_EXEC_OUTPUT_BYTES),
    grant: deviceSponsoredExecGrant.optional(),
    timeoutSeconds: z
      .number()
      .int()
      .min(1)
      .max(DEVICE_EXEC_MS / 1000)
      .optional(),
  })
  .strict()
export type DeviceSponsoredExecRequest = z.infer<typeof deviceSponsoredExecRequest>
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
      /**
       * A forked chat's first turn: `previousState` is its source's session, which this turn
       * branches into a new one instead of resuming. A Desktop without it refuses the request
       * (the schema is strict), never resuming the source's session in two chats.
       */
      forkSession: z.literal(true).optional(),
      /**
       * A side chat's turn (history-store.ts `openSideChat`): read-only, with no Freebuff tools,
       * because its parent's agent is working in the same folder. A Desktop without it refuses
       * the request (the schema is strict), never running a side chat with write access.
       */
      readOnly: z.literal(true).optional(),
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

/** How long the device lets one native CLI turn run before it stops it. */
export const DEVICE_HARNESS_TURN_LIMIT_MS = 60 * 60_000
/** Journal `error` text when a native turn reaches `DEVICE_HARNESS_TURN_LIMIT_MS`. */
export const DEVICE_HARNESS_TIME_LIMIT_MESSAGE =
  'This turn reached the 60-minute limit for a turn running on your computer. Completed steps are saved; send a message to continue.'
/** Journal `error` text when the native turn was stopped (`harness_stop`) before it finished. */
export const DEVICE_HARNESS_STOPPED_MESSAGE =
  'The turn running on your computer was stopped before it finished. Completed steps are saved; send a message to continue.'

export type DeviceHarness = 'codex' | 'claude-code'
const HARNESS_LABEL: Record<DeviceHarness, string> = {
  codex: 'Codex',
  'claude-code': 'Claude Code',
}
const HARNESS_ACCOUNT: Record<DeviceHarness, string> = {
  codex: 'ChatGPT',
  'claude-code': 'Claude',
}
const PICK_FREEBUFF = 'choose a Freebuff model from the model picker to keep going'

/** Desktop's own copy for a turn it could not run, already worded for the
 *  user (harness/claude-code.ts, codex-errors.ts, codex.ts). */
const DESKTOP_WORDED = [
  /^This agent runs your local (Claude Code|Codex CLI), which is signed out\./,
  /^Your organization’s Claude Code policy disables autonomous permission mode\b/,
  /^Freebuff stopped this turn after its Claude Code elevation guard failed\./,
  /\. Update it to keep using this agent, or switch to another from the selector\.$/,
]

/** When the CLI says its plan's limit resets, as it printed it (the computer's own clock). */
function limitReset(message: string): string | null {
  const at =
    /\btry again at ([^()\n]{1,60}?)\.?\s*$/i.exec(message) ??
    /\bresets (?:at )?([^()\n·∙|]{1,40}?(?: \([^)\n]{1,40}\))?)\.?\s*(?:$|[·∙|])/i.exec(message)
  return at?.[1]?.trim() || null
}

/** Added to a failed turn that started without its computer (web `cloudRunErrorMessage`): otherwise
 * the user saw only the generic failure and could not tell the turn never had their files or
 * terminal. The hosted Desktop page finds it in a failed turn's error to offer Reconnect and retry. */
export const DEVICE_UNREACHABLE_RUN_NOTE =
  'Your computer did not respond when this message started, so Freebuff had no access to its files or terminal. Check that Freebuff Desktop is open, then send the message again.'

/**
 * The user-facing message for a native turn's journal `error`, or null when it
 * is not one we can name. Desktop builds before these messages existed wrote the
 * SDK's own text for every abort ("Claude Code process aborted by user").
 *
 * The CLI runs on the user's computer with their own sign-in, so most failures
 * are theirs to fix there: signed out, plan limit used up, a model their plan
 * cannot use. Only fixed classes are named; the CLI's raw text never is (it can
 * quote the request).
 */
export function deviceHarnessFailureMessage(
  message: string,
  harness?: DeviceHarness,
): string | null {
  if (
    message === DEVICE_HARNESS_TIME_LIMIT_MESSAGE ||
    message === DEVICE_HARNESS_STOPPED_MESSAGE
  )
    return message
  if (/process aborted by user/i.test(message))
    return DEVICE_HARNESS_STOPPED_MESSAGE
  if (message.length <= 1000 && DESKTOP_WORDED.some((pattern) => pattern.test(message)))
    return message
  if (!harness) return null
  const label = HARNESS_LABEL[harness]
  const account = HARNESS_ACCOUNT[harness]
  if (
    /\b(hit your (usage )?limit|usage limit reached|(5-hour|weekly|session) limit reached)\b/i.test(
      message,
    )
  ) {
    const reset = limitReset(message)
    return `Your ${account} plan’s ${label} usage limit is used up${reset ? ` until ${reset}` : ''}. Wait for it to reset, or ${PICK_FREEBUFF}.`
  }
  const unsupported =
    /The '([\w.:/-]{1,80})' model is not supported when using Codex with a ChatGPT account/.exec(
      message,
    )
  if (unsupported)
    return `Your ChatGPT plan can’t use ${unsupported[1]} in Codex. Choose another model from the model picker.`
  if (/spend cap set by the owner of your workspace/i.test(message))
    return `Your ${account} workspace’s spend cap for ${label} is used up. Ask a workspace owner to raise it, or ${PICK_FREEBUFF}.`
  if (/\bworkspace is out of credits\b/i.test(message))
    return `Your ${account} workspace is out of ${label} credits. Add credits there, or ${PICK_FREEBUFF}.`
  if (/^Quota exceeded\. Check your plan and billing details|credit balance is too low/i.test(message))
    return `The account ${label} signs in with on your computer is out of quota or credit. Check its plan and billing, or ${PICK_FREEBUFF}.`
  if (new RegExp(`^Could not install ${label}\\b`).test(message))
    return `Freebuff couldn’t install ${label} on your computer. Check that computer’s internet connection, then send your message again.`
  return null
}

/** A native turn's failure that no class names: which CLI failed and where, never its raw text. */
export function deviceHarnessUnnamedFailure(harness: DeviceHarness): string {
  const label = HARNESS_LABEL[harness]
  return `${label} stopped on your computer with an error. Completed steps are saved; send a message to try again. If it keeps happening, run \`${harness === 'codex' ? 'codex' : 'claude'}\` in a terminal on that computer to see why, or ${PICK_FREEBUFF}.`
}
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
  deviceMoveExportRequest,
  deviceAgenticOfferFactsRequest,
  deviceSponsoredExecRequest,
  deviceGitHubRequest,
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
    deviceNames: z.literal(true).optional(),
    enabled: z.boolean(),
    protocolVersion: z.literal(DEVICE_EXECUTION_VERSION),
    methods: z.array(z.enum(['read_file', 'list_directory'])),
    executionProtocolVersion: z.literal(2).optional(),
    nativeProtocolVersion: z.literal(3).optional(),
    panelProtocolVersion: z.literal(1).optional(),
    concurrentHarnesses: z.literal(true).optional(),
    deviceMove: z.literal(true).optional(),
    agenticOffers: z.literal(true).optional(),
    sponsoredExec: z.literal(true).optional(),
    readOnlyOpener: z.literal(true).optional(),
    githubConnect: z.literal(true).optional(),
  })
  .strict()

/** Deterministic UUID-shaped identity from a SHA-256 digest; never a credential. */
export function deviceIdentity(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}
