import { z } from 'zod/v4'

import { normalizeMcpServerUrl } from '../mcp/server-url'

export const CUSTOM_MCP_LIMIT = 20
export const customMcpInputSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[\p{L}\p{N} _.-]+$/u),
    url: z
      .string()
      // Supply the scheme people leave off (`example.com/mcp`) before every check below.
      .overwrite(normalizeMcpServerUrl)
      .url()
      .max(2048)
      // Checked first so it is the message shown. Wording only: the public-address check that
      // actually keeps Cloud off private networks is the transport's, and runs regardless.
      .refine((value) => {
        if (!URL.canParse(value)) return true
        const host = new URL(value).hostname
        return !(
          host === 'localhost' ||
          host.endsWith('.localhost') ||
          host === '[::1]' ||
          host === '0.0.0.0' ||
          /^127\./.test(host)
        )
      }, 'Cloud can’t reach a server on your own computer. Use a public HTTPS URL, or add local servers in the CLI.')
      .refine((value) => {
        // Zod still runs this after `.url()` fails; a throw here would escape `safeParse`.
        if (!URL.canParse(value)) return false
        const url = new URL(value)
        return (
          url.protocol === 'https:' &&
          !url.username &&
          !url.password &&
          !url.hash &&
          !url.search &&
          (!url.port || url.port === '443')
        )
      }, 'Use a public HTTPS URL without credentials or query parameters'),
    token: z
      .string()
      .trim()
      .max(8192)
      .regex(/^[^\r\n]*$/)
      .optional(),
  })
  .strict()
export const customMcpApprovalSchema = z
  .object({
    manifestHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    tools: z.array(z.string().min(1).max(200)).max(200),
  })
  .strict()

export type CustomMcpTool = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }
}
export type CustomMcpServer = {
  id: string
  name: string
  url: string
  enabled: boolean
  manifestHash: string
  tools: CustomMcpTool[]
  approvedTools: string[]
}
export type CustomMcpInput = z.infer<typeof customMcpInputSchema>
