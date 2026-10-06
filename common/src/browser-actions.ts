import { z } from 'zod/v4'

// Result schema for the browser_logs tool.
const LogSchema = z.object({
  type: z.enum(['error', 'warning', 'info', 'debug', 'verbose']),
  message: z.string(),
  timestamp: z.number(),
  location: z.string().optional(),
  stack: z.string().optional(),
  category: z.string().optional(),
  level: z.number().optional(),
  source: z.enum(['browser', 'tool']).default('tool'),
})

const MetricsSchema = z.object({
  loadTime: z.number(),
  memoryUsage: z.number(),
  jsErrors: z.number(),
  networkErrors: z.number(),
  ttfb: z.number().optional(),
  lcp: z.number().optional(),
  fcp: z.number().optional(),
  domContentLoaded: z.number().optional(),
  sessionDuration: z.number().optional(),
})

const NetworkEventSchema = z.object({
  url: z.string(),
  method: z.string(),
  status: z.number().optional(),
  errorText: z.string().optional(),
  timestamp: z.number(),
})

const LogFilterSchema = z.object({
  types: z
    .array(z.enum(['error', 'warning', 'info', 'debug', 'verbose']))
    .optional(),
  minLevel: z.number().optional(),
  categories: z.array(z.string()).optional(),
})

const ImageContentSchema = z.object({
  type: z.literal('image'),
  source: z.object({
    type: z.literal('base64'),
    media_type: z.literal('image/jpeg'),
    data: z.string(),
  }),
})

export const BrowserResponseSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  logs: z.array(LogSchema),
  logFilter: LogFilterSchema.optional(),
  networkEvents: z.array(NetworkEventSchema).optional(),
  metrics: MetricsSchema.optional(),
  screenshots: z
    .object({
      pre: ImageContentSchema.optional(),
      post: ImageContentSchema,
    })
    .optional(),
})
