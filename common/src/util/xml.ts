/**
 * Generate a closing XML tag for a single tool name
 * @param toolName Single tool name to generate closing tag for
 * @returns Closing XML tag string
 */
export function closeXml(toolName: string): string {
  return `</${toolName}>`
}
