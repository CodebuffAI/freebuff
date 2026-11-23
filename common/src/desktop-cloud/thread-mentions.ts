/** Cloud and native Desktop chat IDs live in separate namespaces. Never shorten a Cloud ID. */
export const cloudMentionId = (id: string) => `cloud:${id}`

export function cloudThreadMention(chat: { id: string; title: string }) {
  const title = chat.title.replace(/[\\\]\r\n]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Chat'
  return `@[${title}](thread:${cloudMentionId(chat.id)})`
}

/** Only exact, explicitly Cloud tokens authorize a history read. Native prefixes cannot cross over. */
export function cloudThreadMentionIds(prompt: string): string[] {
  return [...new Set([...prompt.matchAll(/@\[[^\]\r\n]*\]\(thread:cloud:([a-zA-Z0-9_-]{1,128})\)/g)]
    .map(match => match[1]))]
}
