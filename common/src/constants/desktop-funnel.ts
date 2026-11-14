import { z } from 'zod'
import { templateAnalyticsFields } from '../templates/analytics'

export const DESKTOP_FUNNEL_EVENT = 'desktop.funnel_step'
/** Isolated journey events: these IDs are never identified or aliased to accounts. */
export const DESKTOP_ACQUISITION_EVENT = 'desktop.acquisition_step'

export const desktopFunnelStepSchema = z.enum([
  'landing', 'install', 'launch', 'welcome', 'login', 'browser', 'provider', 'connect', 'survey', 'question',
  'template', 'folder', 'composer', 'draft', 'model_picker', 'model_selection', 'send',
  'turn', 'response',
])
export const desktopFunnelStateSchema = z.enum([
  'shown', 'clicked', 'started', 'opened', 'selected', 'applied', 'succeeded',
  'failed', 'skipped', 'back', 'cancelled', 'closed', 'received', 'visible',
])

const entityId = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/)
const modelId = z.string().min(1).max(120).regex(/^[a-zA-Z0-9_./:@-]+$/)
const harness = z.enum(['codebuff', 'claude-code', 'codex'])

// Deliberately closed: no text, local paths, URLs, auth codes or arbitrary property bags.
// Entity IDs are local transport only; Desktop hashes them before external capture.
export const desktopFunnelPropertiesSchema = z.object({
  ...templateAnalyticsFields,
  event_id: z.string().uuid().optional(),
  acquisition_id: z.string().uuid().optional(),
  acquisition_channel: z.enum(['students', 'organic', 'campaign', 'unknown']).optional(),
  flow_id: z.string().uuid().optional(),
  attempt_id: z.string().uuid().optional(),
  thread_id: entityId.optional(),
  input_id: entityId.optional(),
  turn_id: entityId.optional(),
  project_id: entityId.optional(),
  login_surface: z.enum(['splash', 'gate', 'notice', 'feedback', 'unknown']).optional(),
  login_phase: z.enum(['idle', 'starting', 'waiting', 'failed', 'connected']).optional(),
  provider: z.enum(['github', 'google', 'apple', 'email', 'current_account', 'switch_account']).optional(),
  question_id: z.enum(['referral_source', 'role', 'proficiency', 'intended_use', 'subscriptions']).optional(),
  question_index: z.number().int().min(0).max(50).optional(),
  question_count: z.number().int().min(0).max(50).optional(),
  answered_count: z.number().int().min(0).max(50).optional(),
  selection_count: z.number().int().min(0).max(100).optional(),
  has_other_text: z.boolean().optional(),
  project_kind: z.enum(['folder', 'no_folder', 'cloud', 'empty_local', 'cloud_repo', 'cloud_empty', 'template']).optional(),
  harness: harness.optional(),
  previous_harness: harness.optional(),
  model: modelId.optional(),
  previous_model: modelId.optional(),
  selection_kind: z.enum(['default', 'unchanged', 'changed', 'reselected', 'blocked', 'unknown']).optional(),
  reason: z.enum([
    'dismiss', 'escape', 'outside', 'selection', 'navigation', 'error', 'blocked',
    'paywall', 'setup', 'unavailable', 'already_selected', 'empty', 'http',
    'save_failed', 'timeout', 'completed', 'skipped', 'partial', 'unknown',
    'reopen', 'retry', 'cancel', 'unsupported', 'expired', 'invalid',
    'already_connected', 'phone_required', 'closed', 'confirmation',
    'running', 'compacting', 'moving', 'too_long',
  ]).optional(),
  duration_ms: z.number().int().min(0).max(7 * 24 * 60 * 60 * 1000).optional(),
  initiator: z.enum(['user', 'suggestion', 'skill', 'mission', 'coordinator', 'thread_update', 'sponsored', 'api', 'unknown']).optional(),
  queued: z.boolean().optional(),
  restored: z.boolean().optional(),
  has_attachments: z.boolean().optional(),
  has_output: z.boolean().optional(),
  output_kind: z.enum(['text', 'tool']).optional(),
  execution_target: z.enum(['local', 'cloud']).optional(),
}).strict()

export const desktopFunnelEventSchema = desktopFunnelPropertiesSchema.extend({
  step: desktopFunnelStepSchema,
  state: desktopFunnelStateSchema,
})

export type DesktopFunnelStep = z.infer<typeof desktopFunnelStepSchema>
export type DesktopFunnelState = z.infer<typeof desktopFunnelStateSchema>
export type DesktopFunnelProperties = z.infer<typeof desktopFunnelPropertiesSchema>
export type DesktopFunnelEvent = z.infer<typeof desktopFunnelEventSchema>

export const DESKTOP_FUNNEL_LABELS = {
  landing: 'Landing', install: 'Install', launch: 'Launch',
  welcome: 'Welcome', login: 'Login', browser: 'Browser', provider: 'Provider',
  connect: 'Connect', survey: 'Survey', question: 'Question', folder: 'Folder',
  template: 'Template', composer: 'Compose', draft: 'Type', model_picker: 'Models',
  model_selection: 'Select', send: 'Send', turn: 'Complete', response: 'Reply',
} satisfies Record<DesktopFunnelStep, string>
