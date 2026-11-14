// The Desktop updater's surface (freebuff-desktop/electron/updater.cjs), shared
// by the local renderer and the hosted workspace page so both render the same
// cards and send the same actions.

export interface UpdateOffer {
  version: string
  currentVersion: string
  /** what `version` changed, as the markdown bullets cut from CHANGELOG.md at
   *  release time; present only when the release shipped some */
  notes?: string
}

// Owned and pushed by the main process. Everything about a version renders as a
// compact corner card; only the app menu's explicit check answers with a sheet.
export type UpdateCard =
  // downloaded, and installs on the next quit unless the user picks sooner
  | ({ phase: 'ready' } & UpdateOffer)
  // downloaded, and installs once the app goes idle
  | ({ phase: 'armed' } & UpdateOffer)
  | ({ phase: 'installing' } & UpdateOffer)
  | ({ phase: 'downloading'; fraction: number } & UpdateOffer)
  // `stage` is what Try again repeats: a download, or a restart already chosen
  | ({ phase: 'failed'; stage: 'download' | 'install' } & UpdateOffer)
  | ({ phase: 'translocated' } & UpdateOffer)
  | { phase: 'checking'; currentVersion: string }
  | { phase: 'current'; currentVersion: string }
  | { phase: 'check-failed'; currentVersion: string }
  | { phase: 'unavailable'; currentVersion: string }

// 'cancel' means "stop what this card is doing" — abandon the download, or call
// off a restart that is waiting for the app to go quiet. 'later' dismisses.
export type UpdateAction =
  | 'install'
  | 'install-when-idle'
  | 'retry'
  | 'cancel'
  | 'later'
  | 'check-again'
  | 'manual-download'

/** What an explicit check from Settings found. `available` also opens the offer sheet. */
export type UpdateCheckResult =
  | { status: 'current' | 'failed' | 'unavailable' | 'in-progress' }
  | { status: 'available'; version: string }
