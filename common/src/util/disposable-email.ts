/**
 * Classify email domains that referral-abuse detection treats as flags.
 *
 * Two categories, kept separate because they carry different weight:
 *
 * - `disposable` — one-time / throwaway inbox providers. A real person has no
 *   reason to sign up for a durable dev-tool account with an inbox that stops
 *   existing in an hour, so a *referred* account on one of these is a strong
 *   farm signal.
 * - `privacy_relay` — burner-friendly privacy providers and relays
 *   (Proton, Apple private relay, Firefox Relay, SimpleLogin, …). Plenty of
 *   legitimate developers live on these, so a hit is corroborating evidence
 *   only — it must never gate a reward or trigger action on its own.
 *
 * Matching is by exact domain or any subdomain (disposable providers hand out
 * wildcard subdomains). Lists are deliberately curated and small: they exist
 * to catch the providers we actually see in referral farms, not to be a
 * complete registry. Extend them as sweeps surface new ones (note the dated
 * "observed in referral farms" block below).
 */

export type FlaggedEmailDomainKind =
  | 'disposable'
  | 'privacy_relay'
  /** A big-brand consumer privacy mailbox (Proton, Tutanota, Apple
   *  Hide-My-Email, DuckDuckGo, Firefox Relay). Classified so callers can SEE
   *  it, but the spend ceiling deliberately does not price it — see
   *  isSpendCeilingFlaggedEmailDomain. */
  | 'mainstream_privacy'

const DISPOSABLE_EMAIL_DOMAINS = [
  // Classic one-time inbox providers.
  '10minutemail.com',
  'dispostable.com',
  'dropmail.me',
  'emailondeck.com',
  'fakeinbox.com',
  'getnada.com',
  'grr.la',
  'guerrillamail.com',
  'guerrillamail.net',
  'maildrop.cc',
  'mailinator.com',
  'mailnesia.com',
  'mail.tm',
  'minuteinbox.com',
  'mintemail.com',
  'mohmal.com',
  'sharklasers.com',
  'temp-mail.org',
  'tempinbox.com',
  'tempmail.com',
  'tempmail.dev',
  'throwawaymail.com',
  'trashmail.com',
  'yopmail.com',
  // Observed in Freebuff referral farms, 2026-07 (scripted rings minting
  // referred accounts on niche throwaway domains — see the 07-29 sock sweep).
  'aifotoeditor.com',
  'animateany.com',
  'animatimg.com',
  'biscoito.email',
  'oldtranslator.com',
  // Observed 2026-08-01: a 48-account free-mode compute ring, all minted on
  // 12-character random local parts and admitted from one egress IP (peak 30
  // concurrent, four admissions inside two seconds). These are catch-all
  // domains whose subdomains are chosen to read as legitimate at a glance —
  // gmail.l0veyou.com, edu.l0veyou.com, my.l0veyou.com, test123.l0veyou.com,
  // gmail.pumpkinai.space — which subdomain matching above already covers.
  'l0veyou.com',
  'pumpkinai.space',
  'pumpkinai.it.com',
  // Compiled 2026-08-03 from prod, not from a public blocklist: every domain
  // below has >=20 Freebuff accounts and >=75% of them already banned. That
  // covers 7,129 accounts of which 6,699 were banned before this list existed.
  // The threshold is what keeps real providers out — Gmail sits at 0.8%
  // banned, Outlook 11%, Proton 4%, duck.com 30%, and the two school domains
  // that appeared in the raw data (dmpschool.ac.th 12%, sman1pace.sch.id, 5
  // accounts) fail the volume or rate bar. Many are deliberate Gmail
  // lookalikes (gmaiko, gmbel, ggmul, gkmaill, gmito, gmiliu, gmisol) and
  // several were minted in a single day — gmito.my.id put 288 accounts on one
  // date, which no real mailbox provider does.
  'azahram.com',
  'barcondi.my.id',
  'bukitsakura.com',
  'cilisung.com',
  'cindohub.com',
  'duccky.com',
  'fomolu.com',
  'gamlo.my.id',
  'gamontok.com',
  'gehil.my.id',
  'geusil.com',
  'geusil.my.id',
  'ggmul.com',
  'ghyuil.my.id',
  'gkmaill.com',
  'gmaiko.com',
  'gmbel.com',
  'gmiliu.my.id',
  'gmisol.my.id',
  'gmito.my.id',
  'gmole.xyz',
  'gmosel.com',
  'gsuel.my.id',
  'gumel.store',
  'guzeil.com',
  'gwemol.my.id',
  'hayate.us',
  'jokowi.store',
  'jujusa.my.id',
  'mikontol.online',
  'monetsssky1.com',
  'satukataku.com',
  'simosel.site',
  'wdrvk.dpdns.org',
  'wdrvks.eu.org',
  'xabree.com',
  // Added 2026-08-03 on behavioural rather than statistical evidence — these
  // are below the >=20-account bar the block above uses, so they qualify on
  // what their accounts DO instead.
  //
  // proxyvpn.cn: 5 accounts named github, github-1/-2/-3 and master-github,
  // on a proxy-service domain. All five were silent-endpoint callers (free-mode
  // messages with zero client telemetry) running 372-1,435 messages each in
  // 7 days; all five are now banned.
  //
  // The .qd.je pair: 14 accounts each, every one registered on a SINGLE day
  // (impact 2026-07-10, fincy 2026-07-13), and 13 of the 28 surfaced in the
  // silent-endpoint scan. A same-day mint of 14 accounts is not a mailbox
  // provider signing up users.
  //
  // Deliberately NOT added: dns-proxy.com (1 account, no activity, no
  // evidence) and proximus.lu (Belgium's largest telecom — a real ISP whose
  // one user has 791 legitimate messages). A substring rule on "proxy" would
  // have caught both.
  'proxyvpn.cn',
  'impact.qd.je',
  'fincy.qd.je',
  // Compiled 2026-08-15 from 14d of prod logs, while working out why 22.9% of
  // Singapore's active users were hitting a spend ceiling. The restricted
  // ceiling on the SG *geography* was doing two jobs at once: bounding a farm
  // that happens to egress there, and taxing ~270 ordinary developers on
  // gmail/qq/163/outlook. Naming the farm by domain is what lets the geography
  // cap come off — see FREEBUFF_ELEVATED_COUNTRIES.
  //
  // Rates below are "share of the domain's accounts carrying an automated ban
  // or an abuse-detector hit". Baselines from the same
  // window: gmail.com 5%, proton.me 7%, outlook.com 23%.
  //
  // dhisy.com      28 accounts, 93%  — clears the >=20 / >=75% statistical bar
  // dewaa.id       20 accounts, 80%  — clears it
  // sendang.space  13 accounts, 92%  — behavioural: too few accounts for the
  //                                    bar, ban rate far past it
  // yotube.id      18 accounts, 83%  — behavioural, and a YouTube typo-squat
  // gusil.my.id    80 accounts, 68%  — under 75%, but 13x the gmail baseline
  //                                    at real volume, and the same naming
  //                                    family as gsuel/gehil/gmisol.my.id
  //                                    already listed above
  //
  // Deliberately NOT added, and worth recording because both LOOK like members
  // of the family above and are not:
  //   gmisel.com     49 accounts, 2% — indistinguishable from gmail's baseline
  //                                    despite sitting one letter from the
  //                                    listed gmisol.my.id. Name similarity is
  //                                    not evidence; this is the entry the
  //                                    >=75% bar exists to keep out.
  //   cemararaya.id   6 accounts, 33% — too few accounts, rate too low.
  'dhisy.com',
  'dewaa.id',
  'sendang.space',
  'yotube.id',
  'gusil.my.id',
  // Added 2026-08-24. The 08-15 note above says this farm was "now priced by
  // flaggedEmailDomain"; it was priced by the five entries above, and the rest
  // of the family kept registering. These five are still signing up.
  //
  // Qualified on DETECTOR HITS, not on the >=75% account bar, which none of
  // them clear: the share of a domain's accounts carrying one separates these
  // from ordinary mail cleanly. Baselines from the same query: gmail.com 0% of
  // accounts flagged, outlook.com 5%.
  //
  //   duojumbo.online  511 accts  61% banned  52% flagged
  //   gmaoiil.com    1,086 accts  47% banned  34% flagged  (typosquat of gmail)
  //   itesun.com       321 accts  87% banned  30% flagged
  //   duojumbo.com     620 accts  30% banned  24% flagged  (same operator)
  //   geusil.com       446 accts  57% banned  22% flagged
  //
  // Deliberately NOT added, on the same reasoning that kept gmisel.com out:
  //   gieemel.com   295 accts, 35% banned, 0% flagged -- zero detector hits of
  //                 any kind. Looks like the family, behaves like nothing.
  //   bekri.site    306 accts, 23% banned, 18% flagged -- ban rate identical to
  //                 outlook.com's baseline.
  //   gmatos.com    214 accts, 17% banned, 17% flagged -- below that baseline.
  'gmaoiil.com',
  'duojumbo.online',
  'duojumbo.com',
  'itesun.com',
  'geusil.com',
] as const

/**
 * Big-brand consumer privacy mailboxes, lifted OFF the spend ceiling on an
 * operator decision (2026-08-14).
 *
 * These were in the relay list from day one, which put a bot-farm ceiling on
 * every ProtonMail and Tutanota user — mainstream providers whose typical
 * account is one person's primary mailbox, not an alias mint. It also
 * contradicted the pipeline's own doctrine: the IP side refuses to price
 * Apple Private Relay because it is a consumer default, while the email side
 * was pricing Apple's Hide-My-Email. Alias services built for
 * one-address-per-signup (SimpleLogin, AnonAddy, aleeas) stay priced: their
 * product IS mailbox multiplication, which is the thing the flag exists to
 * catch.
 *
 * Still classified — as `mainstream_privacy` — so trust scoring and the
 * abuse scripts can keep seeing them; only the ceiling looks away.
 */
const MAINSTREAM_PRIVACY_EMAIL_DOMAINS = [
  // Proton family (primary mailboxes; passmail.net is Proton's ALIAS product
  // and stays in the relay list below).
  'proton.me',
  'protonmail.ch',
  'protonmail.com',
  'pm.me',
  // Apple "Hide My Email".
  'privaterelay.appleid.com',
  // DuckDuckGo Email Protection.
  'duck.com',
  // Firefox Relay.
  'mozmail.com',
  // Tutanota family.
  'tuta.com',
  'tuta.io',
  'tutamail.com',
  'tutanota.com',
] as const

const PRIVACY_RELAY_EMAIL_DOMAINS = [
  'passmail.net',
  // Alias/relay services.
  'aleeas.com',
  'anonaddy.me',
  'simplelogin.com',
  'simplelogin.io',
] as const

const DISPOSABLE_SET: ReadonlySet<string> = new Set(DISPOSABLE_EMAIL_DOMAINS)
const PRIVACY_RELAY_SET: ReadonlySet<string> = new Set(
  PRIVACY_RELAY_EMAIL_DOMAINS,
)
const MAINSTREAM_PRIVACY_SET: ReadonlySet<string> = new Set(
  MAINSTREAM_PRIVACY_EMAIL_DOMAINS,
)

function domainOf(email: string): string | null {
  const at = email.lastIndexOf('@')
  if (at < 0 || at === email.length - 1) return null
  return email
    .slice(at + 1)
    .trim()
    .toLowerCase()
}

function matchesSet(domain: string, set: ReadonlySet<string>): boolean {
  if (set.has(domain)) return true
  // Subdomain match: a.b.mailinator.com → b.mailinator.com → mailinator.com
  let rest = domain
  for (let dot = rest.indexOf('.'); dot >= 0; dot = rest.indexOf('.')) {
    rest = rest.slice(dot + 1)
    if (set.has(rest)) return true
  }
  return false
}

/** The flag category for `email`'s domain, or null for an ordinary domain
 *  (or an unparseable email). */
/** The curated disposable / farm-provider list, for seeding a server-side
 *  blacklist. Read-only copy; the classification helpers stay authoritative. */
export function listDisposableEmailDomains(): readonly string[] {
  return [...DISPOSABLE_EMAIL_DOMAINS]
}

export function classifyEmailDomain(
  email: string | null | undefined,
): FlaggedEmailDomainKind | null {
  if (!email) return null
  const domain = domainOf(email)
  if (!domain) return null
  if (matchesSet(domain, DISPOSABLE_SET)) return 'disposable'
  if (matchesSet(domain, PRIVACY_RELAY_SET)) return 'privacy_relay'
  if (matchesSet(domain, MAINSTREAM_PRIVACY_SET)) return 'mainstream_privacy'
  return null
}

/**
 * Whether `email`'s domain prices the flagged-domain SPEND CEILING.
 *
 * Deliberately narrower than `classifyEmailDomain !== null`: mainstream
 * consumer privacy mailboxes are classified (so scoring and scripts can see
 * them) but never priced — a ProtonMail address is not evidence of a bot
 * farm, and for two days it was billed as one.
 */
export function isSpendCeilingFlaggedEmailDomain(
  email: string | null | undefined,
): boolean {
  const kind = classifyEmailDomain(email)
  return kind !== null && kind !== 'mainstream_privacy'
}
