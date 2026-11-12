import type { SelectedTemplate } from './selected'

/**
 * Templates that call the Freebuff API (the ai-chat starter) run on the
 * owner's own prepaid API key. The key is a live credential, so the agent
 * never handles it; the README in the template says where it goes.
 */
export const FREEBUFF_API_TEMPLATE_IDS: ReadonlySet<string> = new Set(['ai-chat'])
export const FREEBUFF_API_TEMPLATE_GUIDANCE = `Templates that use AI call the Freebuff API (OpenAI-compatible, https://freebuff.com/api/v1/paid) from their Worker with the owner's own key in OPENAI_API_KEY; the browser never sees it. Never ask for that key in chat, print it, log it, commit it, or put it in client code. The owner creates and funds one at https://freebuff.com/account/api (Desktop: Account → Developer API, which can write it into the project's .env); in Cloud it is a project secret named OPENAI_API_KEY; on Sites it goes in Sites → Secrets after the first deploy. Keep the key in .env, never .dev.vars (its presence stops Wrangler reading .env). Until the key is set the app shows its setup card; that is expected, not a bug. Keep the template's server-side model allowlist, per-user daily limit and loopback-only development user: every reply spends the owner's credits.`

const TEMPLATE_DEFAULTS = `Choose by what the user wants to build, not by framework names. Use the starter's working defaults without asking the user to choose a stack; explain technical choices only when relevant or requested. Honor an explicitly requested language or framework. For hosted features, prefer Freebuff Sites and its DB (D1), FILES (R2) and Sign in with Freebuff where applicable. The API service starter runs on Sites; Sites currently cannot deploy Python/FastAPI servers. If Python is required for a hosted API, explain that hosting limitation before proposing a different host; do not silently replace the requested language.`

/** Standing template guidance shared by Desktop and Cloud harnesses. */
export function templatesGuidance(
  mode: 'plan' | 'build',
  runtime: 'desktop' | 'cloud' = 'desktop',
  selectedTemplate?: SelectedTemplate,
): string {
  const preview = runtime === 'cloud'
    ? 'run bun install, start the dev server bound to 0.0.0.0 and show it with cloud_show_dev_server'
    : 'run bun install, start bun run dev and show it with register_preview'
  const run = `Read the template's README.md for its run commands. For a website, ${preview}. For a CLI or other terminal-only template, run its documented command and show the command and actual terminal output instead; do not start a web server, register a browser preview, or deploy it to Sites. For a browser extension, build it and demonstrate the installed popup in a local browser; WXT's dev server is not a working website preview. In Cloud or without an extension-capable browser, report build/test results and explain the remaining toolbar/active-tab check rather than claiming it works. The extension itself does not deploy to Sites; an optional backend can. This also applies when the first message asks for a live preview.`
  if (selectedTemplate)
    return `# Starter templates

The user already selected the ${JSON.stringify(selectedTemplate.name)} starter template (id: ${JSON.stringify(selectedTemplate.id)}) when creating this project. Its starter code was installed during project creation. Treat the current workspace files as the source of truth; they may already be customized. Start by reading the existing README.md and the relevant source files, then ${mode === 'plan' ? 'plan changes to that code' : "adapt that code to the user's request"}. Preserve changes that have already been made. Do not search for, choose, or apply another template unless the user explicitly asks to replace it.${
      mode === 'build'
        ? ` If the workspace turns out to be empty (no source files, README.md or project configuration), the starter code is missing: say so in one sentence and install this same template with template_apply (id ${JSON.stringify(selectedTemplate.id)}) before doing anything else, rather than building from scratch or describing files that are not there.`
        : ''
    }

${TEMPLATE_DEFAULTS}

${mode === 'plan' ? 'This is an existing project to plan against. Do not install dependencies, start servers, or edit files in plan mode.' : `Make only the changes needed for the user's request. ${run} The template's README.md describes its setup and integrations.`}${
      FREEBUFF_API_TEMPLATE_IDS.has(selectedTemplate.id) ? `\n\n${FREEBUFF_API_TEMPLATE_GUIDANCE}` : ''
    }`
  if (mode === 'plan')
    return `# Starter templates
Freebuff ships starter templates for common websites, apps, APIs and scripts, including minimal foundations; template_list shows the current set. Inspect the workspace before proposing one: a new chat or newly created project may already contain a selected template or other code. If code is present, plan changes to that code. Only when the workspace is empty and a template matches the request, name it in the plan as the starting point and describe what would change. Prefer a minimal starter when the user wants to build from scratch. Applying a template is build-mode work.

${TEMPLATE_DEFAULTS}`
  return `# Starter templates

Freebuff ships starter templates: minimal foundations such as Blank website, Web app, Browser extension, Command-line tool, API service and Automation script, plus complete projects such as marketing and landing pages, CRM-style dashboards, storefronts, portfolios, study or flashcard apps, an AI chat assistant and games. template_list has the current set. The template's description and README specify its runtime, hosting requirements and integrations. Most website templates are Cloudflare Workers ready for Sites; game templates may need their own server. Terminal tools and browser extensions do not need website hosting.

${TEMPLATE_DEFAULTS}

First inspect the workspace and read its README.md and relevant source files if present. A new chat or newly created project may already contain a selected template or other code; build on that code instead of searching for or applying a template.

Start from a template only when the workspace is empty and either the user asks for one, or their first request plainly describes something a template already is (a website from scratch, a web app with accounts and data, a browser extension, a command-line tool, a JSON API, an automation script, a landing page for a product, a CRM, an online store, a portfolio, a flashcard app, a chatbot or AI assistant). Call template_list, choose the closest match, call template_apply with its id, then read the template's README.md and the files you need. Prefer a minimal starter when the user wants to build from scratch instead of importing an unrelated finished product. Adapt the code and any names, copy, data, colours, images and features to the request, and say that you started from a template. If the user only asks to start or preview the template, run it without changing it. When nothing matches, build normally.

After applying: ${run} Read the template's README before deploying. Templates with a Sites deploy.json use sites_deploy; custom game servers and customer-defined Durable Objects are not supported by the managed Sites deployer. Never remove required bindings or point a copied game at a shared demo to bypass that restriction. For Sites app templates, follow their integration setup: sites_add_storage for DB and FILES and sites_enable_auth before a deployed preview can sign in or save data. Optional auth and guest support vary by template.

${FREEBUFF_API_TEMPLATE_GUIDANCE}`
}
