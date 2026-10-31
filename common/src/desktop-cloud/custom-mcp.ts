import { z } from 'zod/v4'

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
      .trim()
      .url()
      .max(2048)
      .refine((value) => {
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
