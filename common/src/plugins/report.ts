/**
 * Reports for Agent Plugins v1.0.0: the findings freebuff surfaces about a
 * plugin, returned as values rather than written to a console.
 *
 * Spec: github.com/agentplugins/agent-plugins-spec/blob/main/spec/1.0.0.md
 */

/**
 * One finding about a plugin: how serious it is, which spec section it comes
 * from (for example `§5.2`), and what to tell the user. Every component
 * produces them — a rejected manifest, a skipped skill, a disabled MCP server.
 */
export interface PluginReport {
  severity: 'error' | 'warning'
  section: string
  message: string
}
