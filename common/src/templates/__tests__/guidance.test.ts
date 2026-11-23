import { describe, expect, test } from 'bun:test'
import { templatesGuidance } from '../guidance'

const template = { id: 'crm', name: 'CRM' }

describe('starter template context', () => {
  for (const runtime of ['desktop', 'cloud'] as const) {
    for (const mode of ['build', 'plan'] as const) {
      test(`${runtime} ${mode} starts from the selected template's existing code`, () => {
        const prompt = templatesGuidance(mode, runtime, template)
        expect(prompt).toContain('already selected the "CRM" starter template')
        expect(prompt).toContain('Its starter code was installed during project creation')
        expect(prompt).toContain('Treat the current workspace files as the source of truth')
        expect(prompt).toContain('existing README.md')
        expect(prompt).toContain('Preserve changes that have already been made')
        expect(prompt).toContain('Do not search for, choose, or apply another template')
        expect(prompt).not.toContain('Call template_list')
        // An empty workspace is reported and repaired with the same template, never papered over.
        if (mode === 'build') expect(prompt).toContain('install this same template with template_apply (id "crm")')
        else expect(prompt).not.toContain('template_apply')
        if (mode === 'plan') {
          expect(prompt).toContain('plan changes to that code')
          expect(prompt).not.toContain('run bun install')
          expect(prompt).not.toContain('show it with')
        } else {
          expect(prompt).toContain("adapt that code to the user's request")
          expect(prompt).toContain("Make only the changes needed for the user's request")
          expect(prompt).toContain(runtime === 'cloud' ? 'cloud_show_dev_server' : 'register_preview')
        }
      })
    }
  }

  test('the Freebuff API key rules ride along only where an AI template is in play', () => {
    const keyRule = 'Never ask for that key in chat'
    // Build mode without provenance may apply ai-chat, so it carries the rules.
    expect(templatesGuidance('build')).toContain(keyRule)
    expect(templatesGuidance('build')).toContain('OPENAI_API_KEY')
    expect(templatesGuidance('build')).toContain('never .dev.vars')
    expect(templatesGuidance('plan')).not.toContain(keyRule)
    // A selected AI template carries them; a selected non-AI template does not.
    for (const runtime of ['desktop', 'cloud'] as const) {
      expect(templatesGuidance('build', runtime, { id: 'ai-chat', name: 'AI chat' })).toContain(keyRule)
      expect(templatesGuidance('plan', runtime, { id: 'ai-chat', name: 'AI chat' })).toContain(keyRule)
      expect(templatesGuidance('build', runtime, template)).not.toContain(keyRule)
    }
  })

  test('projects without provenance must inspect their existing code before selecting a starter', () => {
    for (const mode of ['build', 'plan'] as const) {
      const prompt = templatesGuidance(mode)
      expect(prompt).toContain('new chat or newly created project may already contain a selected template or other code')
      expect(prompt).toContain('workspace is empty')
      expect(prompt).not.toContain('project is new or empty')
    }
  })

  test('minimal starters are discoverable and terminal starters use command output', () => {
    for (const runtime of ['desktop', 'cloud'] as const) {
      const generic = templatesGuidance('build', runtime)
      expect(generic).toContain('Blank website, Web app, Browser extension, Command-line tool, API service and Automation script')
      expect(generic).toContain('Prefer a minimal starter')
      expect(generic).toContain('run it without changing it')
      for (const prompt of [generic, templatesGuidance('build', runtime, { id: 'hello-world-cli', name: 'Hello world CLI' })]) {
        expect(prompt).toContain('actual terminal output instead')
        expect(prompt).toContain('do not start a web server')
        expect(prompt).toContain('first message asks for a live preview')
      }
      expect(templatesGuidance('plan', runtime, { id: 'hello-world-cli', name: 'Hello world CLI' })).not.toContain('run its documented command')
    }
  })

  test('templates choose working defaults by outcome and explain Python hosting constraints', () => {
    for (const mode of ['build', 'plan'] as const) {
      for (const template of [undefined, { id: 'python-script', name: 'Automation script' }, { id: 'json-api', name: 'API service' }]) {
        const prompt = templatesGuidance(mode, 'cloud', template)
        expect(prompt).toContain('not by framework names')
        expect(prompt).toContain('without asking the user to choose a stack')
        expect(prompt).toContain('Honor an explicitly requested language or framework')
        expect(prompt).toContain('prefer Freebuff Sites')
        expect(prompt).toContain('cannot deploy Python/FastAPI servers')
        expect(prompt).toContain('do not silently replace the requested language')
      }
    }
  })

  test('extension setup does not confuse a browser popup with a hosted website', () => {
    for (const runtime of ['desktop', 'cloud'] as const) {
      const prompt = templatesGuidance('build', runtime, { id: 'browser-extension', name: 'Browser extension' })
      expect(prompt).toContain('demonstrate the installed popup')
      expect(prompt).toContain("WXT's dev server is not a working website preview")
      expect(prompt).toContain('remaining toolbar/active-tab check')
      expect(prompt).toContain('extension itself does not deploy to Sites')
    }
  })
})
