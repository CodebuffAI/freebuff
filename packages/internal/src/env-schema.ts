import { clientEnvSchema, clientProcessEnv } from '@codebuff/common/env-schema'
import z from 'zod/v4'

export const serverEnvSchema = clientEnvSchema.extend({
  // LLM API keys
  OPEN_ROUTER_API_KEY: z.string().min(1),
  OPENAI_API_KEY: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  FIREWORKS_API_KEY: z.string().min(1),
  MOONSHOT_API_KEY: z.string().min(1).optional(),
  CANOPYWAVE_API_KEY: z.string().min(1).optional(),
  DEEPSEEK_API_KEY: z.string().min(1).optional(),
  SILICONFLOW_API_KEY: z.string().min(1).optional(),
  OPENCODE_API_KEY: z.string().min(1).optional(),
  SERPER_API_KEY: z.string().min(1),
  CONTEXT7_API_KEY: z.string().optional(),
  GRAVITY_API_KEY: z.string().min(1),
  IPINFO_TOKEN: z.string().min(1),
  SPUR_TOKEN: z.string().min(1),
  SCAMALYTICS_API_KEY: z.string().min(1),
  COMPOSIO_API_KEY: z.string().min(1).optional(),
  // ZeroClick tenant API key used for server-side offer fallback requests.
  ZEROCLICK_API_KEY: z.string().min(1).optional(),
  // BuySellAds (Carbon) zone key used for the Freebuff waiting-room ad.
  // Optional: when unset the Carbon provider returns no ad and callers fall
  // back to their cached ads / fallback content. `CVADC53U` is the public
  // test key from BSA docs and is safe to use in dev.
  CARBON_ZONE_KEY: z.string().min(1).optional(),
  PORT: z.coerce.number().min(1000),

  // Web/Database variables
  DATABASE_URL: z.string().min(1),
  CODEBUFF_GITHUB_ID: z.string().min(1),
  CODEBUFF_GITHUB_SECRET: z.string().min(1),
  FREEBUFF_GITHUB_ID: z.string().min(1).optional(),
  FREEBUFF_GITHUB_SECRET: z.string().min(1).optional(),
  NEXTAUTH_URL: z.url().optional(),
  NEXTAUTH_SECRET: z.string().min(1),
  STRIPE_SECRET_KEY: z.string().min(1),
  STRIPE_WEBHOOK_SECRET_KEY: z.string().min(1),
  STRIPE_TEAM_FEE_PRICE_ID: z.string().min(1),
  STRIPE_SUBSCRIPTION_100_PRICE_ID: z.string().min(1),
  STRIPE_SUBSCRIPTION_200_PRICE_ID: z.string().min(1),
  STRIPE_SUBSCRIPTION_500_PRICE_ID: z.string().min(1),
  LOOPS_API_KEY: z.string().min(1),
  DISCORD_PUBLIC_KEY: z.string().min(1),
  DISCORD_BOT_TOKEN: z.string().min(1),
  DISCORD_APPLICATION_ID: z.string().min(1),

  // Shared secret for the hourly bot-sweep GitHub Action. Callers must send
  // `Authorization: Bearer $BOT_SWEEP_SECRET` to /api/admin/bot-sweep.
  // Optional so dev environments can start without it; the endpoint returns
  // 503 if the secret isn't configured.
  BOT_SWEEP_SECRET: z.string().min(16).optional(),

  // Optional GitHub PAT used by the bot-sweep to look up each suspect's
  // GitHub account age. Without it we fall back to unauthenticated API
  // calls (60 req/hr from the server IP) which is enough for a normal
  // sweep but risks rate-limiting.
  BOT_SWEEP_GITHUB_TOKEN: z.string().min(1).optional(),

  FREEBUFF_SESSION_LENGTH_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 60 * 1000),

  // Dev-only override: when 'true', force free-mode requests to the 'limited'
  // access tier so the limited UX (single DeepSeek Flash model) can be
  // exercised on localhost. Ignored unless NEXT_PUBLIC_CB_ENVIRONMENT === 'dev'.
  FREEBUFF_DEV_FORCE_LIMITED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
})
export const serverEnvVars = serverEnvSchema.keyof().options
export type ServerEnvVar = (typeof serverEnvVars)[number]
export type ServerInput = {
  [K in (typeof serverEnvVars)[number]]: string | undefined
}
export type ServerEnv = z.infer<typeof serverEnvSchema>

// CI-only env vars that are NOT in the typed schema
// These are injected for SDK tests but should never be accessed via env.* in code
export const ciOnlyEnvVars = ['CODEBUFF_API_KEY'] as const
export type CiOnlyEnvVar = (typeof ciOnlyEnvVars)[number]

// Bun will inject all these values, so we need to reference them individually (no for-loops)
export const serverProcessEnv: ServerInput = {
  ...clientProcessEnv,

  // LLM API keys
  OPEN_ROUTER_API_KEY: process.env.OPEN_ROUTER_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  FIREWORKS_API_KEY: process.env.FIREWORKS_API_KEY,
  MOONSHOT_API_KEY: process.env.MOONSHOT_API_KEY,
  CANOPYWAVE_API_KEY: process.env.CANOPYWAVE_API_KEY,
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
  SILICONFLOW_API_KEY: process.env.SILICONFLOW_API_KEY,
  OPENCODE_API_KEY: process.env.OPENCODE_API_KEY,
  SERPER_API_KEY: process.env.SERPER_API_KEY,
  CONTEXT7_API_KEY: process.env.CONTEXT7_API_KEY,
  GRAVITY_API_KEY: process.env.GRAVITY_API_KEY,
  IPINFO_TOKEN: process.env.IPINFO_TOKEN,
  SPUR_TOKEN: process.env.SPUR_TOKEN,
  SCAMALYTICS_API_KEY: process.env.SCAMALYTICS_API_KEY,
  COMPOSIO_API_KEY: process.env.COMPOSIO_API_KEY,
  ZEROCLICK_API_KEY: process.env.ZEROCLICK_API_KEY,
  CARBON_ZONE_KEY: process.env.CARBON_ZONE_KEY,
  PORT: process.env.PORT,

  // Web/Database variables
  DATABASE_URL: process.env.DATABASE_URL,
  CODEBUFF_GITHUB_ID: process.env.CODEBUFF_GITHUB_ID,
  CODEBUFF_GITHUB_SECRET: process.env.CODEBUFF_GITHUB_SECRET,
  FREEBUFF_GITHUB_ID: process.env.FREEBUFF_GITHUB_ID,
  FREEBUFF_GITHUB_SECRET: process.env.FREEBUFF_GITHUB_SECRET,
  NEXTAUTH_URL: process.env.NEXTAUTH_URL,
  NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET,
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET_KEY: process.env.STRIPE_WEBHOOK_SECRET_KEY,
  STRIPE_TEAM_FEE_PRICE_ID: process.env.STRIPE_TEAM_FEE_PRICE_ID,
  STRIPE_SUBSCRIPTION_100_PRICE_ID:
    process.env.STRIPE_SUBSCRIPTION_100_PRICE_ID,
  STRIPE_SUBSCRIPTION_200_PRICE_ID:
    process.env.STRIPE_SUBSCRIPTION_200_PRICE_ID,
  STRIPE_SUBSCRIPTION_500_PRICE_ID:
    process.env.STRIPE_SUBSCRIPTION_500_PRICE_ID,
  LOOPS_API_KEY: process.env.LOOPS_API_KEY,
  DISCORD_PUBLIC_KEY: process.env.DISCORD_PUBLIC_KEY,
  DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
  DISCORD_APPLICATION_ID: process.env.DISCORD_APPLICATION_ID,
  BOT_SWEEP_SECRET: process.env.BOT_SWEEP_SECRET,
  BOT_SWEEP_GITHUB_TOKEN: process.env.BOT_SWEEP_GITHUB_TOKEN,

  // Freebuff session gate
  FREEBUFF_SESSION_LENGTH_MS: process.env.FREEBUFF_SESSION_LENGTH_MS,
  FREEBUFF_DEV_FORCE_LIMITED: process.env.FREEBUFF_DEV_FORCE_LIMITED,
}
