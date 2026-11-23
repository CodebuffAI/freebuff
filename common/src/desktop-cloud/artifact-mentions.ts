import { ARTIFACT_KINDS, type ArtifactKind } from './artifacts'
import { QUOTE_LEAD_IN } from './artifact-quote-frame'

export const ARTIFACT_MENTION_LABELS: Record<ArtifactKind, string> = {
  doc: 'Docs',
  slides: 'Slides',
  sheet: 'Sheets',
  data: 'Data',
  whiteboard: 'Whiteboard',
  design: 'Design',
}

export const ARTIFACT_MENTIONS: readonly {
  kind: ArtifactKind
  name: string
  label: string
  aliases: readonly string[]
}[] = [
  { kind: 'doc', name: 'docs', label: 'Docs', aliases: ['doc', 'docs', 'document', 'documents'] },
  { kind: 'slides', name: 'slides', label: 'Slides', aliases: ['slide', 'slides', 'deck', 'presentation', 'presentations'] },
  { kind: 'sheet', name: 'sheets', label: 'Sheets', aliases: ['sheet', 'sheets', 'spreadsheet', 'spreadsheets', 'excel'] },
  { kind: 'data', name: 'data', label: 'Data', aliases: ['data', 'dashboard', 'dashboards'] },
  { kind: 'whiteboard', name: 'whiteboard', label: 'Whiteboard', aliases: ['whiteboard', 'whiteboards', 'board'] },
  { kind: 'design', name: 'design', label: 'Design', aliases: ['design', 'designs'] },
]

export type ArtifactMention = {
  start: number
  end: number
  text: string
  kind: ArtifactKind
  label: string
}

/** The selected format is carried by the same prompt through drafts, queues and history. */
export function artifactMention(kind: ArtifactKind): string {
  return `@[${ARTIFACT_MENTION_LABELS[kind]}](artifact:${kind})`
}

/** Raw token ranges for composer and message chips. Tokens do not grant artifact access. */
export function readArtifactMentions(text: string): ArtifactMention[] {
  const mentions: ArtifactMention[] = []
  for (const match of text.matchAll(/@\[(Docs|Slides|Sheets|Data|Whiteboard|Design)\]\(artifact:(doc|slides|sheet|data|whiteboard|design)\)/g)) {
    const kind = match[2] as ArtifactKind
    if (match[1] !== ARTIFACT_MENTION_LABELS[kind]) continue
    mentions.push({ start: match.index, end: match.index + match[0].length, text: match[0], kind, label: match[1] })
  }
  return mentions
}

/** Format choices in the user's prose, excluding quoted content and Markdown code examples. */
export function artifactMentionKinds(prompt: string, allowed: readonly ArtifactKind[] = ARTIFACT_KINDS): ArtifactKind[] {
  const kinds = new Set<ArtifactKind>()
  let fence: { marker: string; length: number } | null = null
  let inlineTicks = 0
  for (const line of prompt.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence) {
      if (marker?.[0] === fence.marker && marker.length >= fence.length && /^ {0,3}(?:`+|~+)[ \t]*$/.test(line)) fence = null
      continue
    }
    if (/^(?: {0,3}>| {4}|\t)/.test(line) || line.trimStart().startsWith(QUOTE_LEAD_IN)) continue
    if (marker) {
      fence = { marker: marker[0], length: marker.length }
      continue
    }
    let prose = ''
    for (const part of line.split(/(`+)/)) {
      if (/^`+$/.test(part)) {
        if (!inlineTicks) inlineTicks = part.length
        else if (inlineTicks === part.length) inlineTicks = 0
        prose += ' '.repeat(part.length)
      } else prose += inlineTicks ? ' '.repeat(part.length) : part
    }
    for (const mention of readArtifactMentions(prose)) {
      const escapes = /\\+$/.exec(prose.slice(0, mention.start))?.[0].length ?? 0
      if (escapes % 2) continue
      if (allowed.includes(mention.kind)) kinds.add(mention.kind)
    }
  }
  return [...kinds]
}
