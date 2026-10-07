/** Read-only account projection. No credentials, checkout grants, or mutation URLs. */
export type SettingsSnapshot = {
  groups: { title: string; rows: { label: string; value: string }[] }[]
}
export const ACCOUNT_SETTINGS_READS = [
  'account',
  'connections',
  'api',
  'referrals',
  'bounties',
  'offers',
] as const
export type AccountSettingsRead = (typeof ACCOUNT_SETTINGS_READS)[number]
