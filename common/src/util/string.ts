import { sumBy } from 'lodash'

export const truncateString = (str: string, maxLength: number) => {
  if (str.length <= maxLength) {
    return str
  }
  return str.slice(0, maxLength) + '...'
}

export const truncateStringWithMessage = ({
  str,
  maxLength,
  message = 'TRUNCATED DUE TO LENGTH',
  remove = 'END',
}: {
  str: string
  maxLength: number
  message?: string
  remove?: 'END' | 'START' | 'MIDDLE'
}) => {
  if (str.length <= maxLength) {
    return str
  }

  if (remove === 'END') {
    const suffix = `\n[${message}...]`
    const availableLength = Math.max(0, maxLength - suffix.length)
    return str.slice(0, availableLength) + suffix
  }
  if (remove === 'START') {
    const prefix = `[...${message}]\n`
    const availableLength = Math.max(0, maxLength - prefix.length)
    return prefix + str.slice(str.length - availableLength)
  }

  const middle = `\n[...${message}...]\n`
  const length = Math.max(0, Math.floor((maxLength - middle.length) / 2))
  return str.slice(0, length) + middle + str.slice(-length)
}

/**
 * Check if a character is a whitespace character according
 * to the XML spec (space, carriage return, line feed or tab)
 *
 * @param character Character to check
 * @return Whether the character is whitespace or not
 */
export const isWhitespace = (character: string) => /\s/.test(character)

export const randBoolFromStr = (str: string) => {
  return sumBy(str.split(''), (char) => char.charCodeAt(0)) % 2 === 0
}

// Irregular plurals that cannot be derived from rules
// Note: -sis → -ses words are handled by rule, not listed here
const IRREGULAR_PLURALS: Record<string, string> = {
  // Common English irregulars
  person: 'people',
  child: 'children',
  man: 'men',
  woman: 'women',
  mouse: 'mice', // computer mice
  // Tech terms with -ex/-ix → -ices (no reliable rule)
  index: 'indices',
  vertex: 'vertices',
  matrix: 'matrices',
  appendix: 'appendices',
  // Latin -um → -a (too many exceptions like forum→forums for a rule)
  datum: 'data',
  medium: 'media',
  criterion: 'criteria',
  phenomenon: 'phenomena',
  // Latin -us → -i (too many exceptions like bus→buses for a rule)
  stimulus: 'stimuli',
  radius: 'radii',
  focus: 'foci',
  cactus: 'cacti',
  nucleus: 'nuclei',
  syllabus: 'syllabi',
}

// Words that stay the same in plural (only those not derivable from rules)
// Note: -ware words and -ics words are handled by rules, not listed here
const UNCHANGING_PLURALS = new Set([
  // Uncountable/mass nouns in tech
  'data', // already plural of datum, but often used as uncountable
  'metadata',
  'info',
  'feedback',
  'news',
  // Words ending in -s that don't change
  'series',
  'species',
  'chassis',
  'corps',
  'means',
])

// Words ending in -f that just add -s (exceptions to -f → -ves rule)
const F_EXCEPTIONS = new Set([
  // Tech/common terms
  'roof',
  'proof', // proofs (mathematical proofs, design proofs)
  'chief', // tech leads
  'brief', // design briefs
  'belief',
  'cliff',
  'staff',
  'bluff',
  'spoof',
  'motif', // design motifs
  'serif', // fonts
  'tariff',
  'plaintiff',
  'sheriff',
  'reef',
  'chef',
  'ref',
  'gif', // GIFs
  'pdf', // PDFs
])

// Words ending in -o that just add -s (exceptions to -o → -oes rule)
const O_EXCEPTIONS = new Set([
  // Tech terms
  'photo',
  'video',
  'audio',
  'studio',
  'logo',
  'demo',
  'memo',
  'repo', // repositories
  'info',
  'typo',
  'intro',
  'outro',
  'combo',
  'promo',
  'proto', // prototypes
  'retro',
  'macro',
  'micro',
  'nano',
  'auto',
  'euro',
  'pro',
  'disco',
  'duo',
  'trio',
  'solo',
  'piano',
  'casino',
  'ratio',
  'portfolio',
  'scenario',
  'studio',
  'folio',
  'manifesto',
  'motto',
  'dynamo',
  'limo',
  'albino',
  'espresso',
  'fiasco',
  'ghetto',
  'grotto',
  'inferno',
  'jumbo',
  'kimono',
  'libido',
  'lingo',
  'memento',
  'neutrino',
  'placebo',
  'silo', // data silos
  'stiletto',
  'tempo',
  'torso',
  'virtuoso',
  'volcano',
  'zero',
])

export const pluralize = (
  count: number,
  word: string,
  { includeCount = true }: { includeCount?: boolean } = {},
) => {
  let pluralWord: string
  const lowerWord = word.toLowerCase()

  if (count === 1) {
    pluralWord = word
  } else if (word === word.toUpperCase() && word.length > 1) {
    // Acronyms (API, SDK, URL, etc.) - just add 's'
    pluralWord = word + 's'
  } else if (IRREGULAR_PLURALS[lowerWord]) {
    // Check irregular plurals first (truly irregular words)
    pluralWord = IRREGULAR_PLURALS[lowerWord]
  } else if (UNCHANGING_PLURALS.has(lowerWord)) {
    // Specific words that don't change
    pluralWord = word
  } else if (lowerWord.endsWith('ware')) {
    // Rule: -ware words stay unchanged (software, hardware, firmware, malware, etc.)
    pluralWord = word
  } else if (lowerWord.endsWith('ics')) {
    // Rule: -ics words stay unchanged (analytics, graphics, physics, statistics, etc.)
    pluralWord = word
  } else if (lowerWord.endsWith('sis')) {
    // Rule: -sis → -ses (analysis→analyses, basis→bases, crisis→crises, etc.)
    pluralWord = word.slice(0, -2) + 'es'
  } else if (lowerWord.endsWith('xis')) {
    // Rule: -xis → -xes (axis→axes)
    pluralWord = word.slice(0, -2) + 'es'
  } else if (F_EXCEPTIONS.has(lowerWord)) {
    // -f words that just add -s
    pluralWord = word + 's'
  } else if (word.endsWith('f')) {
    // Handle words ending in -f → -ves
    pluralWord = word.slice(0, -1) + 'ves'
  } else if (word.endsWith('fe')) {
    // Handle words ending in -fe → -ves
    pluralWord = word.slice(0, -2) + 'ves'
  } else if (word.endsWith('y') && !word.match(/[aeiou]y$/)) {
    // Handle words ending in 'y' (unless preceded by a vowel)
    pluralWord = word.slice(0, -1) + 'ies'
  } else if (O_EXCEPTIONS.has(lowerWord)) {
    // -o words that just add -s
    pluralWord = word + 's'
  } else if (word.match(/[cs]h$/) || word.match(/o$/)) {
    // Handle words ending in sh, ch, o → add -es
    pluralWord = word + 'es'
  } else if (word.match(/[^z]z$/)) {
    // Single z at end (not zz) → double the z and add -es (quiz → quizzes)
    pluralWord = word + 'zes'
  } else if (word.match(/[sxz]$/)) {
    // Handle words ending in s, x, zz → add -es
    pluralWord = word + 'es'
  } else {
    pluralWord = word + 's'
  }

  return includeCount ? `${count} ${pluralWord}` : pluralWord
}

/**
 * Safely replaces all occurrences of a search string with a replacement string,
 * escaping special replacement patterns (like $) in the replacement string.
 */
export const capitalize = (str: string): string => {
  if (!str) return str
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase()
}

/**
 * Converts a snake_case string to Title Case
 * Example: "add_subgoal" -> "Add Subgoal"
 */
export const snakeToTitleCase = (str: string): string => {
  return str
    .split('_')
    .map((word) => capitalize(word))
    .join(' ')
}

/**
 * Ensures a URL has the appropriate protocol (http:// or https://)
 * Uses http:// for localhost and local IPs, https:// for all other domains
 */
export const ensureUrlProtocol = (url: string): string => {
  if (
    url.startsWith('http://') ||
    url.startsWith('https://') ||
    url.startsWith('file://')
  ) {
    return url
  }

  if (url.startsWith('localhost') || url.match(/^127\.\d+\.\d+\.\d+/)) {
    return `http://${url}`
  }

  if (url.startsWith('/')) {
    return `file://${url}`
  }

  return `https://${url}`
}

export const safeReplace = (
  content: string,
  searchStr: string,
  replaceStr: string,
): string => {
  const escapedReplaceStr = replaceStr.replace(/\$/g, '$$$$')
  return content.replace(searchStr, escapedReplaceStr)
}

/**
 * Extracts a JSON field from a string, transforms it, and puts it back.
 * Handles both array and object JSON values.
 * @param content The string containing JSON-like content
 * @param field The field name to find and transform
 * @param transform Function to transform the parsed JSON value
 * @param fallback String to use if parsing fails
 * @returns The content string with the transformed JSON field
 */
export function transformJsonInString<T = unknown>(
  content: string,
  field: string,
  transform: (json: T) => unknown,
  fallback: string,
): string {
  // Use a non-greedy match for objects/arrays to prevent over-matching
  const pattern = new RegExp(`"${field}"\\s*:\\s*(\\{[^}]*?\\}|\\[[^\\]]*?\\])`)
  const match = content.match(pattern)

  if (!match) {
    return content
  }

  try {
    const json = JSON.parse(match[1])
    const transformed = transform(json)

    // Important: Only replace the exact matched portion to prevent duplicates
    return content.replace(
      match[0],
      `"${field}":${JSON.stringify(transformed)}`,
    )
  } catch (error) {
    // Only replace the exact matched portion even in error case
    return content.replace(match[0], `"${field}":${fallback}`)
  }
}

/**
 * Generates a compact unique identifier by combining timestamp bits with random bits.
 * Uses 40 bits of timestamp (enough for ~34 years) and 24 random bits for exactly 64 total bits.
 * Encodes in base64url for compact, URL-safe strings (~11 chars).
 * @param prefix Optional prefix to add to the ID
 * @returns A unique string ID
 * @example
 * generateCompactId()      // => "1a2b3c4d5e6"
 * generateCompactId('msg-') // => "msg-1a2b3c4d5e6"
 */
export const generateCompactId = (prefix?: string): string => {
  // Get the last 32 bits of the timestamp
  const timestamp = (Date.now() & 0xffffffff) >>> 0
  // Generate a 32-bit random number
  const random = Math.floor(Math.random() * 0x100000000) >>> 0

  // Combine them into a 64-bit representation as two 32-bit numbers
  const high = timestamp
  const low = random

  // Convert to a hex string, pad if necessary, and combine
  const highHex = high.toString(16).padStart(8, '0')
  const lowHex = low.toString(16).padStart(8, '0')

  const combinedHex = highHex + lowHex

  // Convert hex to a Buffer and then to base64url
  const bytes = Buffer.from(combinedHex, 'hex')
  const str = bytes.toString('base64url').replace(/=/g, '')

  return prefix ? `${prefix}${str}` : str
}

/**
 * Removes null characters from a string
 */
export const stripNullChars = (str: string): string => {
  return str.replace(/\u0000/g, '')
}

const ansiColorsRegex = /\x1B\[[0-9;]*m/g
export function stripColors(str: string): string {
  return str.replace(ansiColorsRegex, '')
}

const ansiRegex = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x1B]*\x1B\\?)/g
export function stripAnsi(str: string): string {
  return str.replace(ansiRegex, '')
}

export function includesMatch(
  array: (string | RegExp)[],
  value: string,
): boolean {
  return array.some((p) => {
    if (typeof p === 'string') {
      return p === value
    }
    return p.test(value)
  })
}

/**
 * Finds the longest substring that is **both** a suffix of `source`
 * **and** a prefix of `next`.
 * Useful when concatenating strings while avoiding duplicate overlap.
 *
 * @example
 * ```ts
 * suffixPrefixOverlap('foobar', 'barbaz'); // ➜ 'bar'
 * suffixPrefixOverlap('abc', 'def');       // ➜ ''
 * ```
 *
 * @param source  The string whose **suffix** is inspected.
 * @param next    The string whose **prefix** is inspected.
 * @returns       The longest overlapping edge, or an empty string if none exists.
 */
export function suffixPrefixOverlap(source: string, next: string): string {
  for (let len = next.length; len >= 0; len--) {
    const prefix = next.slice(0, len)
    if (source.endsWith(prefix)) {
      return prefix
    }
  }

  return ''
}

export const escapeString = (str: string) => {
  return JSON.stringify(str).slice(1, -1)
}
