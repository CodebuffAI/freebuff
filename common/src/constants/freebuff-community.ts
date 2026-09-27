/**
 * The Freebuff Discord, for every surface that asks people to join it: the
 * Desktop sidebar and feedback forms, the CLI after a sign-in, and the browser
 * page a CLI or Desktop sign-in lands on. One invite and one headline count so
 * the surfaces cannot drift apart. Both are public.
 *
 * The count is a floor, not a live number: the server had 7,621 members on
 * 2026-09-27. Raise it by hand, in whole thousands, once the server passes the
 * next one — rounding down is what keeps the copy true without a lookup.
 */
export const FREEBUFF_DISCORD_INVITE_URL = 'https://discord.gg/yXG3w7wxfs'
export const FREEBUFF_DISCORD_MEMBERS_LABEL = '7,000+'
