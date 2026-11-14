/** Advertiser-facing closing explanation, never a transcript or a result override. */
export const SPONSORED_RUN_SUMMARY_MAX = 800
export const SPONSORED_RUN_SUMMARY_INSTRUCTION =
  'Before ending a completed or blocked run, call report_sponsored_run_summary if available. Write two or three plain sentences for the advertiser explaining what actually completed, what failed or remains unverified, and why. Base it on the final checks and conversion observations. Do not claim success for unfinished work. No user identities, project details, code, file paths, URLs, account IDs, credentials or copied page/tool output. This summary explains the result; it does not determine success or count conversions.'

/** Zod-free: the same read/write boundary runs in Desktop, Next and Convex. */
export function scrubSponsoredRunSummary(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const text = raw
    .slice(0, 4000)
    .replace(/```[\s\S]*?(?:```|$)/g, '[code omitted]')
    .replace(
      /\b(?:authorization\s*:\s*)?Bearer\s+\S+/gi,
      '[credential omitted]',
    )
    .replace(
      /\b(?:api[ _-]?key|token|secret|password)\s*[:=]\s*\S+/gi,
      '[credential omitted]',
    )
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url omitted]')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email omitted]')
    .replace(/\b[a-z]:[\\/][^\s;,)]*/gi, '[path omitted]')
    .replace(
      /(^|[\s(=:`'"])~?\/(?!dev\/null\b)[^\s;,)`'"]+/g,
      '$1[path omitted]',
    )
    .replace(/\b[\w.-]+(?:\/[\w.-]+)+\.[a-z0-9]{1,8}\b/gi, '[path omitted]')
    .replace(/\b[A-Za-z0-9_+=.-]{24,}\b/g, '[identifier omitted]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text ? text.slice(0, SPONSORED_RUN_SUMMARY_MAX) : null
}
