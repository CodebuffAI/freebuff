/**
 * Repairs for tool-call argument JSON that a model got slightly wrong.
 *
 * Each repair rewrites the raw text and is kept only if the result parses; the tool's schema then
 * validates it like any other call. To handle a newly common slip, add an entry with the trace
 * evidence and a test case built from a real failing call.
 */
export const TOOL_JSON_REPAIRS: readonly {
  name: string
  repair: (text: string) => string | undefined
}[] = [
  // DeepSeek V4 Flash, Nov 2026 (replayed production contexts, 25 of 429 str_replace calls broken):
  // a `"` in the code left unescaped (`"newString": "<div className="card">"`, JSX's `{" "}`).
  // Served through some lanes the broken text arrives as `replacements: "<that text>"`.
  { name: 'unescaped-quote', repair: escapeStrayQuotes },
  // Same sample: a raw newline inside a string.
  { name: 'raw-control-character', repair: escapeControlCharacters },
  // Same sample: the `replacements` array closed with `}` instead of `]}`.
  { name: 'unclosed-array', repair: closeArraysBeforeBraces },
]

/**
 * `text` parsed, if it parses as is or after the repairs. Repairs apply in order, each to the
 * previous one's output, since one call can carry several slips.
 */
export function parseToolJson(
  text: string,
): { value: unknown; repair?: string } | undefined {
  try {
    return { value: JSON.parse(text) }
  } catch {}
  const applied: string[] = []
  for (const { name, repair } of TOOL_JSON_REPAIRS) {
    const repaired = repair(text)
    if (repaired === undefined) continue
    text = repaired
    applied.push(name)
    try {
      return { value: JSON.parse(text), repair: applied.join('+') }
    } catch {}
  }
  return undefined
}

/** Calls `visit` for each character with whether it sits inside a string (escapes skipped). */
function scan(
  text: string,
  visit: (ch: string, inString: boolean) => string,
): string | undefined {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (inString && ch === '\\') {
      out += ch + (text[i + 1] ?? '')
      i++
      continue
    }
    out += visit(ch, inString)
    if (ch === '"') inString = !inString
  }
  return out === text ? undefined : out
}

function escapeControlCharacters(text: string): string | undefined {
  return scan(text, (ch, inString) =>
    inString && ch < ' ' ? JSON.stringify(ch).slice(1, -1) : ch,
  )
}

function closeArraysBeforeBraces(text: string): string | undefined {
  const containers: string[] = []
  return scan(text, (ch, inString) => {
    if (inString) return ch
    if (ch === '{' || ch === '[') containers.push(ch)
    if (ch !== '}' && ch !== ']') return ch
    let closers = ''
    while (ch === '}' && containers.at(-1) === '[') {
      containers.pop()
      closers += ']'
    }
    containers.pop()
    return closers + ch
  })
}

// What may follow a string's real closing quote, by where the string sits.
const AFTER_KEY = /\s*:/y
const AFTER_OBJECT_VALUE = /\s*(?:\}\s*(?:[,\]}]|$)|,\s*"(?:[^"\\]|\\.)*"\s*:)/y
const AFTER_ARRAY_VALUE = /\s*(?:\]\s*(?:[,\]}]|$)|,\s*["{[\-\dtfn])/y
const AFTER_TOP_LEVEL = /\s*$/y

/**
 * Escapes each `"` inside a string that cannot be its closing quote: one not followed by what the
 * JSON around it needs next (a `:` after a key; `}` or `, "key":` after an object value). Undefined
 * when there is nothing to escape.
 */
function escapeStrayQuotes(text: string): string | undefined {
  const containers: ('{' | '[')[] = []
  let out = ''
  let inString = false
  let isKey = false
  let expectKey = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (inString) {
      if (ch === '\\') {
        out += ch + (text[i + 1] ?? '')
        i++
        continue
      }
      if (ch !== '"') {
        out += ch
        continue
      }
      const container = containers.at(-1)
      const follow = isKey
        ? AFTER_KEY
        : container === '{'
          ? AFTER_OBJECT_VALUE
          : container === '['
            ? AFTER_ARRAY_VALUE
            : AFTER_TOP_LEVEL
      follow.lastIndex = i + 1
      if (follow.test(text)) {
        out += ch
        inString = false
      } else {
        out += '\\"'
      }
      continue
    }
    out += ch
    if (ch === '"') {
      inString = true
      isKey = expectKey
    } else if (ch === '{' || ch === '[') {
      containers.push(ch)
      expectKey = ch === '{'
    } else if (ch === '}' || ch === ']') {
      containers.pop()
    } else if (ch === ',') {
      expectKey = containers.at(-1) === '{'
    } else if (ch === ':') {
      expectKey = false
    }
  }
  return out === text ? undefined : out
}
