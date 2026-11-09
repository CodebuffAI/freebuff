import z from 'zod/v4'

import {
  $getNativeToolCallExampleString,
  coerceToObject,
  jsonToolResultSchema,
} from '../utils'

import type { $ToolParams } from '../../constants'

const toolName = 'render_ui'
const endsAgentStep = false

const buttonLinkSchema = z
  .string()
  .url()
  .refine(
    (value) => {
      try {
        const url = new URL(value)
        return url.protocol === 'https:' || url.protocol === 'http:'
      } catch {
        return false
      }
    },
    { message: 'Button links must use http:// or https://' },
  )

const gravityIndexButtonLinkSchema = z
  .object({
    source: z.literal('gravity_index'),
    search_id: z
      .string()
      .min(1)
      .describe('The exact search_id returned by gravity_index.'),
    service_slug: z
      .string()
      .min(1)
      .describe(
        'The exact slug of the recommendation or option selected from that search.',
      ),
  })
  .describe(
    'A reference to a tracked click URL in a prior gravity_index search result. The runtime substitutes the exact stored URL.',
  )

export type RenderUIGravityIndexLink = z.infer<
  typeof gravityIndexButtonLinkSchema
>

const buttonWidgetBaseSchema = z.object({
  type: z
    .literal('button')
    .describe('Widget type. Currently, the only supported widget is button.'),
  text: z
    .string()
    .min(1)
    .max(80)
    .describe('Short button label shown to the user.'),
  variant: z
    .enum(['primary', 'secondary'])
    .optional()
    .default('primary')
    .describe(
      'Theme-aware color treatment. Use primary for the main action and secondary for lower-emphasis actions.',
    ),
})

const resolvedButtonWidgetSchema = buttonWidgetBaseSchema.extend({
  link: buttonLinkSchema.describe(
    'The http:// or https:// URL to open when the user clicks the button.',
  ),
  // Stamped by the runtime when the link came from a gravity_index reference,
  // never supplied by the model. It is what lets a surface tell a retraction
  // ("use Postmark instead") from a second recommendation (a database AND an
  // email sender): one selection stands per search, but separate searches each
  // keep their own button, and their own tracked setup link.
  gravity_search_id: z.string().min(1).optional(),
})

const buttonWidgetSchema = buttonWidgetBaseSchema.extend({
  link: z
    .union([buttonLinkSchema, gravityIndexButtonLinkSchema])
    .describe(
      'Either an http(s) URL or a gravity_index reference that the runtime resolves to the exact tracked click URL.',
    ),
})

export type RenderUIButtonWidget = z.infer<typeof resolvedButtonWidgetSchema>

/**
 * Validates the resolved widget shape consumed by UI surfaces. Keeping this
 * beside the tool schema gives CLI, Chat, Web, and Cloud one runtime contract.
 */
export function parseRenderUIButtonWidget(
  widget: unknown,
): RenderUIButtonWidget | null {
  const rawLink =
    widget && typeof widget === 'object' && !Array.isArray(widget)
      ? (widget as { link?: unknown }).link
      : undefined
  if (typeof rawLink !== 'string') return null

  const result = resolvedButtonWidgetSchema.safeParse(widget)
  if (!result.success || result.data.link !== rawLink) return null

  const text = result.data.text.trim()
  return text ? { ...result.data, text } : null
}

const widgetSchema = z.discriminatedUnion('type', [buttonWidgetSchema])

const inputSchema = z
  .object({
    // A widget sent as a JSON string is read as the object it encodes.
    widget: z
      .preprocess(coerceToObject, widgetSchema)
      .describe('The UI widget to render.'),
  })
  .describe('Render a small interactive UI widget for the user.')

const outputSchema = z.object({
  message: z.string(),
})

const description = `
Render a small interactive UI widget for the user.

Currently supported widgets:
- button: renders a clickable button with text and an http(s) link.

Use this when the user should click a clear action, such as opening a generated report, documentation page, checkout page, deployment URL, preview, or dashboard.

For a service selected from a gravity_index search, do not copy its opaque URL. Set \`link\` to a gravity_index reference containing the exact \`search_id\` and selected \`service_slug\`. The runtime verifies the selection against prior tool results and substitutes the exact stored click URL. Call render_ui only after deciding which service to recommend.

Color variants:
- primary: the main action
- secondary: a lower-emphasis action

Keep button text short and action-oriented.

${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {
    widget: {
      type: 'button',
      text: 'Open preview',
      link: 'https://example.com/preview',
      variant: 'primary',
    },
  },
  endsAgentStep,
})}

${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {
    widget: {
      type: 'button',
      text: 'Get your Resend API key',
      link: {
        source: 'gravity_index',
        search_id: 'search_id_from_gravity_index',
        service_slug: 'resend',
      },
      variant: 'primary',
    },
  },
  endsAgentStep,
})}
`.trim()

export const renderUIParams = {
  toolName,
  endsAgentStep,
  description,
  inputSchema,
  outputSchema: jsonToolResultSchema(outputSchema),
} satisfies $ToolParams
