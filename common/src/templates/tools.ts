import { z } from 'zod/v4'

import { TEMPLATE_ID } from './catalog'

/**
 * The agent's template tools, shared by Desktop and Cloud exactly as the Sites
 * tools are (`common/src/sites/tools.ts`): one spec here, a runtime adapter in
 * each harness. `template_list` is read-only and allowed in plan mode;
 * `template_apply` writes into the workspace and is build-mode only.
 */
export type TemplateToolSpec = {
  name: string
  description: string
  shape: z.ZodRawShape
}

export const TEMPLATE_ARGS = {
  id: z.string().regex(TEMPLATE_ID).describe('A template id from template_list.'),
}

export const TEMPLATE_READ_TOOLS = new Set(['template_list'])

export const TEMPLATE_TOOL_SPECS: TemplateToolSpec[] = [
  {
    name: 'template_list',
    description:
      'List the starter templates Freebuff can install into an empty project: each id, name, what it is, and which Freebuff integrations (auth, database, storage) it already wires up. Inspect the workspace first: a new chat or project may already contain the user’s selected template or other code. Use this to choose a starting point for an empty workspace, or when the user explicitly asks to explore templates.',
    shape: {},
  },
  {
    name: 'template_apply',
    description:
      'Install a starter template into this workspace: downloads the template and writes its files into the project root. Refuses if any of the template’s top-level files already exist here, so use it only for a new or empty project, and only when the user asked for a template or their request clearly matches one. Afterwards read the template’s README.md and the files you need, adapt it as needed to the user’s request, and tell the user you started from the template. Follow its run commands: websites have browser previews, command-line tools use terminal output, and browser extensions run installed in a browser.',
    shape: { id: TEMPLATE_ARGS.id },
  },
]
