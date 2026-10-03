import os from 'node:os'
import path from 'node:path'

/**
 * The plugins root: `FREEBUFF_PLUGINS_ROOT` when set, else
 * `~/.agents/plugins` — beside the `~/.agents/skills` and
 * `~/.agents/mcp.json` roots the session already reads (§9.1's example
 * layout). The override must be absolute so installs cannot land relative
 * to whatever directory the CLI starts in; tests use it to stay out of the
 * real home.
 */
export function getPluginsRoot(): string {
  const configured = process.env.FREEBUFF_PLUGINS_ROOT
  if (configured) {
    if (!path.isAbsolute(configured)) {
      throw new Error(
        'FREEBUFF_PLUGINS_ROOT must be an absolute path so plugin installs cannot land relative to the current project.',
      )
    }
    return configured
  }
  return path.join(os.homedir(), '.agents', 'plugins')
}
