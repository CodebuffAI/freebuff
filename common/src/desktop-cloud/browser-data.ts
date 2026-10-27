/** Only display metadata crosses the Electron bridge; source paths and secrets stay in main. */
export interface BrowserImportSource {
  id: string
  label: string
  browser: string
  profileName: string
  hasCookies: boolean
  access?: 'blocked'
  supportsExtensions: boolean
}

export interface BrowserExtension {
  id: string
  name: string
  version: string
  permissions: string[]
  warnings: string[]
  loaded?: boolean
}

export interface BrowserImportCount {
  imported: number
  skipped: number
  warnings: string[]
  skippedReasons?: Record<string, number>
}

export interface BrowserImportResult {
  cancelled?: boolean
  accessBlocked?: boolean
  cookies?: BrowserImportCount
  extensions?: BrowserImportCount
  warnings: string[]
}

/** The native process resolves each source id; paths and cookie values never cross this API. */
export type HostedBrowserDataRequest =
  | { action: 'access' }
  | { action: 'open-access-settings' }
  | { action: 'reveal-app' }
  | { action: 'profiles' }
  | { action: 'extensions' }
  | { action: 'import-file' }
  | { action: 'source'; sourceId: string }
  | {
      action: 'import'
      sourceId: string
      cookies: boolean
      extensionIds: string[]
    }
  | { action: 'remove-extension'; extensionId: string }

export interface HostedBrowserDataResponses {
  access: {
    platform: string
    permissionApp?: string
    browsers: { browser: string; blocked: boolean; profiles: number }[]
  }
  'open-access-settings': { ok: true }
  'reveal-app': { ok: true }
  profiles: {
    profiles: BrowserImportSource[]
    platform: string
    permissionApp?: string
  }
  source: { extensions: BrowserExtension[] }
  extensions: { extensions: BrowserExtension[] }
  import: BrowserImportResult
  'import-file': BrowserImportResult
  'remove-extension': { ok: true; cancelled?: boolean }
}

export type BrowserDataTransport = <T extends HostedBrowserDataRequest>(
  request: T,
) => Promise<HostedBrowserDataResponses[T['action']]>
