/**
 * Where a finding's "More" link goes: the vendor's own documentation for the setting the steps
 * name. Only stable vendor pages belong here. Freebuff policy (plans, Freebucks, refunds, bans) is
 * never explained by diagnostics; those questions go to support.
 */
export const LEARN_MORE = {
  gitSafeDirectory: 'https://git-scm.com/docs/git-config#Documentation/git-config.txt-safedirectory',
  controlledFolderAccess: 'https://learn.microsoft.com/defender-endpoint/customize-controlled-folders',
  linuxInotify: 'https://man7.org/linux/man-pages/man7/inotify.7.html',
  windowsLongPaths: 'https://learn.microsoft.com/windows/win32/fileio/maximum-file-path-limitation',
} as const

export const SUPPORT_EMAIL = 'support@freebuff.com'
