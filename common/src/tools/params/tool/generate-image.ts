import z from 'zod/v4'

import { $getNativeToolCallExampleString, jsonToolResultSchema } from '../utils'

import type { $ToolParams } from '../../constants'

/**
 * Every size is about one megapixel, FLUX's native resolution, and one of the
 * sizes Luminal's FLUX.2 Klein accepts (it refuses any other). The model picks
 * a shape, never a pixel count, so the per-image cost stays fixed.
 */
export const GENERATE_IMAGE_SIZES = {
  '1:1': { width: 1024, height: 1024 },
  '16:9': { width: 1392, height: 752 },
  '9:16': { width: 752, height: 1392 },
  '4:3': { width: 1184, height: 880 },
  '3:4': { width: 880, height: 1184 },
  '3:2': { width: 1248, height: 832 },
  '2:3': { width: 832, height: 1248 },
  '21:9': { width: 1568, height: 672 },
  '9:21': { width: 672, height: 1568 },
} as const

export type GenerateImageAspectRatio = keyof typeof GENERATE_IMAGE_SIZES

export const GENERATE_IMAGE_ASPECT_RATIOS = Object.keys(
  GENERATE_IMAGE_SIZES,
) as [GenerateImageAspectRatio, ...GenerateImageAspectRatio[]]

export const GENERATE_IMAGE_MAX_PROMPT_CHARS = 2000

/**
 * How long the route waits on a Klein job before answering. Klein usually
 * takes seconds but has run 15 s to 3.5 min under load, and every job we stop
 * waiting on is still billed, so wait as long as the edge allows: Cloudflare,
 * which proxies www.codebuff.com, answers 524 when an origin sends no headers
 * for 100 s. The client waits longer than the route, so the route's answer,
 * not a client timeout and a paid resubmit, ends the call.
 */
export const GENERATE_IMAGE_DEADLINE_MS = 95_000
export const GENERATE_IMAGE_CLIENT_TIMEOUT_MS = GENERATE_IMAGE_DEADLINE_MS + 10_000
/** How long the client keeps resuming one job (Klein has run 3.5 min). */
export const GENERATE_IMAGE_MAX_WAIT_MS = 5 * 60_000

const toolName = 'generate_image'
const endsAgentStep = true
const inputSchema = z
  .object({
    prompt: z
      .string()
      .trim()
      .min(1)
      .max(GENERATE_IMAGE_MAX_PROMPT_CHARS)
      .describe(
        'A concrete description of the image: subject, setting, style, composition, colors and lighting.',
      ),
    aspect_ratio: z
      .enum(GENERATE_IMAGE_ASPECT_RATIOS)
      .optional()
      .describe(
        `Shape of the image (default 1:1): ${Object.entries(GENERATE_IMAGE_SIZES)
          .map(([ratio, { width, height }]) => `${ratio} ${width}x${height}`)
          .join(', ')}.`,
      ),
  })
  .describe('Generate one image from a text prompt.')

const description = `
Generate one image (about one megapixel) from a text prompt, for example a hero image, illustration, background, product shot or placeholder art the user's project needs. Use it only when the request calls for new images.

It returns a temporary URL to a JPEG. Download it into the project right away with run_terminal_command (for example \`curl -fsSL -o public/images/hero.jpg "<url>"\`) and reference the local file. Never put the URL itself in code: it expires within the hour.

Write a specific prompt and choose the aspect_ratio that fits where the image goes. Generated text, logos and exact layouts are unreliable; build those in code instead. Generate the images the work needs, not variations.

Example:
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {
    prompt:
      'A cozy mountain cabin at dusk, warm light in the windows, snow-covered pines, soft watercolor style, muted blue and orange palette',
    aspect_ratio: '16:9',
  },
  endsAgentStep,
})}
`.trim()

export const generateImageParams = {
  toolName,
  endsAgentStep,
  description,
  inputSchema,
  outputSchema: jsonToolResultSchema(
    z.union([
      z.object({
        url: z.string(),
        width: z.number(),
        height: z.number(),
      }),
      z.object({
        errorMessage: z.string(),
      }),
    ]),
  ),
} satisfies $ToolParams
