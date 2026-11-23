/** Public metadata only. A connected app's credentials never leave the server. */
export type IntegrationApp = {
  /** Catalog slug, e.g. `gmail`. */
  slug: string
  name: string
  /** Served from Freebuff's logo route, never a third-party host. */
  logo: string
  /** What connecting it lets the agent do; curated apps only. */
  description?: string
}

/** One account the user connected for an app. */
export type IntegrationAccount = {
  /** Opaque id; the server checks ownership before acting on it. */
  id: string
  /** Short, token-friendly handle the agent passes to choose this account. */
  handle: string
  /** The provider's own name for the account, e.g. its email address. */
  label: string | null
  connectedAt: string
}

export type IntegrationConnection = {
  app: IntegrationApp
  accounts: IntegrationAccount[]
}

export type IntegrationsOverview = {
  /** False when this environment has no integrations configured. */
  available: boolean
  connections: IntegrationConnection[]
  /** The Popular category's apps, for clients that predate `categories`. */
  featured: IntegrationApp[]
  /** Browsable sections, in order; absent from servers that predate them. */
  categories?: IntegrationCategory[]
}

export type IntegrationCategory = {
  id: string
  title: string
  apps: IntegrationApp[]
}

export type IntegrationsClient = {
  overview(): Promise<IntegrationsOverview>
  search(
    query: string,
    signal?: AbortSignal,
  ): Promise<{ apps: IntegrationApp[] }>
  connect(app: string): Promise<{ url: string }>
  disconnect(accountId: string): Promise<void>
}

/** Freebuff web page that finishes a connection for the signed-in account. */
export const INTEGRATIONS_CALLBACK_PATH = '/integrations/callback'
/** Freebuff web route that serves an app's logo by slug. */
export const INTEGRATION_LOGO_PATH = '/api/integrations/logo'
/** BroadcastChannel the callback page posts to, so an open Settings tab updates at once. */
export const INTEGRATIONS_CHANNEL = 'freebuff-integrations'

export const MAX_INTEGRATION_ACCOUNTS_PER_APP = 5
export const MAX_INTEGRATION_SEARCH_CHARS = 80

/** The marketing set (house ads, the landing page); the app's Integrations page shows `INTEGRATION_CATEGORIES`. */
export const FEATURED_INTEGRATIONS = [
  'gmail',
  'googlecalendar',
  'googledrive',
  'slack',
  'notion',
  'linear',
  'posthog',
  'sentry',
  'stripe',
  'supabase',
  'hubspot',
  'outlook',
] as const

/**
 * Browsable before the user searches, in this order; each app in its order.
 * The catalog drops any slug a user can't connect without an OAuth app of ours.
 */
export const INTEGRATION_CATEGORIES = [
  {
    id: 'popular',
    title: 'Popular',
    apps: [
      'gmail',
      'googledrive',
      'googlecalendar',
      'github',
      'slack',
      'notion',
      'linear',
      'outlook',
      'googlesheets',
      'googledocs',
      'hubspot',
      'stripe',
    ],
  },
  {
    id: 'developer',
    title: 'Developer tools',
    apps: [
      'github',
      'linear',
      'sentry',
      'supabase',
      'vercel',
      'posthog',
      'gitlab',
      'jira',
      'bitbucket',
      'neon',
      'render',
      'cloudflare',
      'datadog',
      'figma',
      'firecrawl',
    ],
  },
  {
    id: 'communication',
    title: 'Communication',
    apps: [
      'gmail',
      'slack',
      'outlook',
      'discord',
      'microsoft_teams',
      'zoom',
      'telegram',
      'whatsapp',
      'calendly',
    ],
  },
  {
    id: 'productivity',
    title: 'Docs & projects',
    apps: [
      'notion',
      'googledocs',
      'googlesheets',
      'airtable',
      'asana',
      'clickup',
      'trello',
      'monday',
      'confluence',
      'todoist',
      'miro',
      'coda',
      'basecamp',
      'googleslides',
    ],
  },
  {
    id: 'files',
    title: 'Files & design',
    apps: [
      'googledrive',
      'dropbox',
      'one_drive',
      'box',
      'share_point',
      'canva',
      'figma',
    ],
  },
  {
    id: 'sales',
    title: 'Sales & support',
    apps: [
      'hubspot',
      'salesforce',
      'attio',
      'pipedrive',
      'zendesk',
      'intercom',
      'freshdesk',
      'apollo',
    ],
  },
  {
    id: 'finance',
    title: 'Payments & finance',
    apps: ['stripe', 'square', 'quickbooks', 'brex', 'gumroad'],
  },
  {
    id: 'marketing',
    title: 'Marketing & analytics',
    apps: [
      'google_analytics',
      'posthog',
      'mixpanel',
      'amplitude',
      'googleads',
      'metaads',
      'mailchimp',
      'typeform',
      'ahrefs',
      'semrush',
      'linkedin',
      'youtube',
      'reddit',
      'instagram',
      'facebook',
    ],
  },
  {
    id: 'research',
    title: 'AI & research',
    apps: [
      'perplexityai',
      'exa',
      'tavily',
      'firecrawl',
      'elevenlabs',
      'openai',
    ],
  },
] as const satisfies readonly {
  id: string
  title: string
  apps: readonly string[]
}[]

type CuratedIntegration =
  (typeof INTEGRATION_CATEGORIES)[number]['apps'][number]

/** Our one-line copy for each curated app; the catalog's own text is marketing. */
export const INTEGRATION_DESCRIPTIONS: Record<CuratedIntegration, string> = {
  gmail: 'Read, search and send email',
  googledrive: 'Find and organize Drive files',
  googlecalendar: 'Check and schedule events',
  github: 'Issues, pull requests and repos',
  slack: 'Read and send Slack messages',
  notion: 'Search and edit Notion pages',
  linear: 'Triage and update issues',
  outlook: 'Outlook mail and calendar',
  googlesheets: 'Read and update spreadsheets',
  googledocs: 'Read and write Google Docs',
  googleslides: 'Build and edit presentations',
  hubspot: 'Contacts, deals and pipelines',
  stripe: 'Payments, customers and revenue',
  sentry: 'Investigate errors and issues',
  supabase: 'Manage projects and databases',
  vercel: 'Deployments, domains and logs',
  posthog: 'Product analytics and flags',
  gitlab: 'Merge requests, issues and CI',
  jira: 'Track and update Jira issues',
  bitbucket: 'Repositories and pull requests',
  neon: 'Serverless Postgres projects',
  render: 'Services, deploys and logs',
  cloudflare: 'DNS, Workers and zones',
  datadog: 'Metrics, monitors and logs',
  figma: 'Read designs and comments',
  firecrawl: 'Crawl and scrape websites',
  discord: 'Servers, channels and messages',
  microsoft_teams: 'Teams chats and channels',
  zoom: 'Meetings and recordings',
  telegram: 'Send and read Telegram messages',
  whatsapp: 'Business messaging',
  calendly: 'Scheduling links and bookings',
  airtable: 'Bases, tables and records',
  asana: 'Projects and tasks',
  clickup: 'Tasks, docs and goals',
  trello: 'Boards, lists and cards',
  monday: 'Boards and work items',
  confluence: 'Search and edit wiki pages',
  todoist: 'Tasks and to-do lists',
  miro: 'Whiteboards and diagrams',
  coda: 'Docs, tables and automations',
  basecamp: 'Projects, to-dos and messages',
  dropbox: 'Find and share files',
  one_drive: 'OneDrive files and folders',
  box: 'Content and file sharing',
  share_point: 'Sites, lists and documents',
  canva: 'Designs and brand assets',
  salesforce: 'Accounts, leads and opportunities',
  attio: 'Records, lists and notes',
  pipedrive: 'Deals and sales pipeline',
  zendesk: 'Support tickets and users',
  intercom: 'Conversations and contacts',
  freshdesk: 'Help desk tickets',
  apollo: 'Prospects and enrichment',
  square: 'Payments, orders and catalog',
  quickbooks: 'Accounting, invoices and payroll',
  brex: 'Cards, spend and expenses',
  gumroad: 'Products, sales and customers',
  google_analytics: 'Traffic and conversion reports',
  mixpanel: 'Events and funnels',
  amplitude: 'Product analytics',
  googleads: 'Campaigns and performance',
  metaads: 'Facebook and Instagram ads',
  mailchimp: 'Audiences and campaigns',
  typeform: 'Forms and responses',
  ahrefs: 'Backlinks and keyword research',
  semrush: 'SEO and competitor research',
  linkedin: 'Posts and profile',
  youtube: 'Videos, channels and playlists',
  reddit: 'Posts, comments and subreddits',
  instagram: 'Posts and insights',
  facebook: 'Pages and posts',
  perplexityai: 'Answers with web citations',
  exa: 'Search the web for content',
  tavily: 'Web search for agents',
  elevenlabs: 'Voices, speech and audio',
  openai: 'Models, images and files',
}

const SLUG = /^[a-z0-9][a-z0-9_]{0,63}$/
const ACCOUNT_ID = /^[a-zA-Z0-9_-]{1,64}$/

export function validIntegrationSlug(value: unknown): value is string {
  return typeof value === 'string' && SLUG.test(value)
}

export function validIntegrationAccountId(value: unknown): value is string {
  return typeof value === 'string' && ACCOUNT_ID.test(value)
}

export function integrationLogoUrl(origin: string, slug: string): string {
  return new URL(`${INTEGRATION_LOGO_PATH}/${slug}`, origin).href
}
