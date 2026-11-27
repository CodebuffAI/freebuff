/**
 * Hosting addresses users may not claim, shared by freebuff.app hosting
 * (`<slug>.freebuff.app`) and Sites (`<label>.freebuff.site`). Either is a
 * public address on our own domain, so a claimed `login` or `account` is a
 * ready-made phishing page carrying our name. Also covers the hostnames
 * infrastructure tends to expect (`api`, `cdn`, `mail`) and ones that ARE
 * infrastructure — `auth.freebuff.app` is the sign-in email relay generated
 * projects call — whose meaning must never be user-controlled.
 *
 * freebuff.app checks it in two layers: at claim time (createDeployment / slug
 * rename in freebuff/web/convex/deployment.ts, where the user gets a friendly
 * error) and again in the deploy pipeline itself (getOrCreateVercelProject),
 * which every path — web, cloud, agent redeploys, browser-publish finalize —
 * funnels through, so a slug that slipped in through an older row or a path
 * without the claim check still cannot reach a `<reserved>.freebuff.app`
 * domain. Sites checks it, with `impersonatesFreebuff` below, in
 * siteSubdomainError (sites/subdomain.ts) whenever an address is chosen.
 *
 * Offensive names are refused at the same places by
 * freebuff/web/lib/offensiveHostingSlugs.ts, which stays out of common/
 * (published) so its terms never leave the private repo.
 */
export const RESERVED_HOSTING_SLUGS = new Set([
  'about',
  'account',
  'accounts',
  'admin',
  'api',
  'app',
  'auth',
  'billing',
  'blog',
  // Our Buffcraft game (its own record in the freebuff.app zone).
  'buffcraft',
  'cdn',
  'chat',
  'checkout',
  'cli',
  'cloud',
  'codebuff',
  'dashboard',
  'desktop',
  'dev',
  'docs',
  'download',
  'downloads',
  // Email: `mail.freebuff.app` and `news.freebuff.app` are sending domains
  // (DKIM, MAIL FROM) and `*.email.freebuff.app` hosts the email platform.
  'email',
  'freebuff',
  'help',
  // The integrations gateway (its own record in the freebuff.app zone).
  'integrations',
  'internal',
  'login',
  'logout',
  'mail',
  'me',
  'new',
  'news',
  'newsletter',
  'noreply',
  'pay',
  'payment',
  'payments',
  'preview',
  'pricing',
  'root',
  'secure',
  'security',
  'settings',
  'signin',
  'signup',
  'smtp',
  'ssl',
  'staging',
  'static',
  'status',
  'support',
  'team',
  'test',
  'verify',
  'vly',
  'wallet',
  'web',
  'www',
])

export function isReservedHostingSlug(slug: string): boolean {
  return RESERVED_HOSTING_SLUGS.has(slug.trim().toLowerCase())
}

/**
 * Brand look-alikes. A Sites address that reads as Freebuff or Codebuff
 * (`freebuff-airdrop`, `free-buff`, `fr33buff`, `freebuf`, `c0debuff`) passes
 * a site off as ours on our own domain. Sites refuses one that is chosen
 * (siteSubdomainError); the address generated from a project name drops the
 * words that read as it instead (siteNameSlug), so the site is still created.
 * freebuff.app keeps only the exact reserved words above.
 *
 * The rule, anywhere in the label: each letter of the name, where every letter
 * may repeat or appear once (`frebuf`, `freeebuff`), hyphens may fall between
 * any two letters, and a few characters that read as a letter in an address
 * count as it: 0 as o, 3 as e, 8 as b, v as u, `cl` as d. Strict on purpose:
 * a false positive (`free-buffet`, `codebuffer`) costs one rename, a miss is
 * a phishing page on our domain.
 */
const LOOKALIKES: Record<string, string> = {
  b: '[b8]',
  c: 'c',
  d: '(?:d|cl)',
  e: '[e3]',
  f: 'f',
  o: '[o0]',
  r: 'r',
  u: '[uv]',
}

function lookalikePattern(name: string) {
  // `freebuff` → f r e b u f: a doubled letter is one that repeats.
  const letters = [...name.replace(/(.)\1+/g, '$1')]
  return letters.map((letter) => `(?:${LOOKALIKES[letter]}-*)+`).join('')
}

const BRAND = new RegExp(
  ['freebuff', 'codebuff'].map(lookalikePattern).join('|'),
)

/** Whether a hostname label reads as Freebuff or Codebuff. */
export function impersonatesFreebuff(label: string): boolean {
  return BRAND.test(label.toLowerCase())
}

/**
 * A hyphenated label with the words that read as Freebuff or Codebuff
 * dropped: `freebuff-airdrop` → `airdrop`, `free-buff-shop` → `shop`. Whole
 * words go, never part of one, so no fragment (`reebuff`) is left behind.
 * May return an empty string.
 */
export function withoutFreebuffBrand(label: string): string {
  const words = label
    .toLowerCase()
    .split('-')
    .filter((word) => word && !impersonatesFreebuff(word))
  // The name spread over several words (`free-buff`, `fr33-8-uff`): drop the
  // shortest run that reads as it, until none does.
  for (let run = brandRun(words); run; run = brandRun(words))
    words.splice(run.start, run.length)
  return words.join('-')
}

function brandRun(words: string[]) {
  for (let length = 2; length <= words.length; length++)
    for (let start = 0; start + length <= words.length; start++)
      if (impersonatesFreebuff(words.slice(start, start + length).join('-')))
        return { start, length }
  return null
}
