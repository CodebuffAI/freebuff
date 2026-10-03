import { describe, test, expect, afterEach } from 'bun:test'

import { createRunConfig, isSensitiveFile } from '../../utils/create-run-config'
import {
  __setSkillsForTests,
  __resetSkillRegistryForTests,
} from '../../utils/skill-registry'

import type { EventHandlerState } from '../../utils/sdk-event-handlers'
import type { SkillDefinition } from '@codebuff/common/types/skill'
import type { Logger } from '@codebuff/common/types/contracts/logger'

describe('isSensitiveFile', () => {
  test.each([
    // Env files (blocked)
    ['.env', true],
    ['.ENV', true],
    ['.env.local', true],
    ['.env/./', true],
    ['.env ', true],
    ['.env:$DATA', true],
    ['config\\.Env.Production', true],
    ['config/.env.production', true],

    // Env templates (allowed)
    ['.env.example', false],
    ['.ENV.EXAMPLE', false],
    ['.env.sample', false],
    ['.env.template', false],

    // Sensitive extensions
    ['private.pem', true],
    ['server.key', true],
    ['cert.p12', true],
    ['app.keystore', true],
    ['server.crt', true],

    // Sensitive basenames
    ['.htpasswd', true],
    ['.netrc', true],
    ['credentials', true],
    ['.npmrc', true],
    ['.yarnrc.yml', true],
    ['auth.json', true],
    ['terraform.tfvars', true],

    // SSH keys (prefix pattern)
    ['id_rsa', true],
    ['id_ed25519', true],
    ['id_rsa_github', true],
    ['id_rsa.pub', false], // public keys allowed

    // Credentials suffix pattern
    ['aws_credentials', true],
    ['db_credentials', true],

    // Substring patterns
    ['kubeconfig', true],
    ['my-kubeconfig.yaml', true],
    ['terraform.tfstate', true],
    ['prod.tfstate.backup', true],

    // Non-sensitive (should NOT be blocked)
    ['package.json', false],
    ['README.md', false],
    ['src/index.ts', false],
    ['.envrc', false],
    ['credentials.ts', false],
    ['terraform.tf', false],
    ['kube-config.ts', false],
  ])('%s → %s', (file, expected) => {
    expect(isSensitiveFile(file)).toBe(expected)
  })
})

describe('createRunConfig', () => {
  afterEach(() => {
    __resetSkillRegistryForTests()
  })

  /** The parts of an event-handler state a run config creation touches
   *  (the handlers themselves are never invoked in these tests). */
  const eventHandlerState: EventHandlerState = {
    streaming: {
      streamRefs: undefined as never,
      setStreamingAgents: () => {},
      setStreamStatus: () => {},
    },
    message: {
      aiMessageId: 'ai-1',
      updater: undefined as never,
      hasReceivedContentRef: { current: false },
    },
    subagents: {
      addActiveSubagent: () => {},
      removeActiveSubagent: () => {},
    },
    mode: { agentMode: 'DEFAULT', setHasReceivedPlanResponse: () => {} },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    } as Logger,
    setIsRetrying: () => {},
  }

  test("every run hands the session the registry's skill cache", async () => {
    /** Given the registry cache holds a skill (the way an installed
     *  plugin's skill does after startup), when a run config is built
     *  and its skill loader runs, the session's skills include that
     *  skill — the SDK's own loader reads only project/home dirs, so
     *  this loader is what carries plugin skills into the session. */
    const seeded: SkillDefinition = {
      name: 'gcloud-setup',
      description: 'sets up gcloud',
      content: '# gcloud setup',
      filePath: '/skills/gcloud-setup/SKILL.md',
    }
    __setSkillsForTests({ 'gcloud-setup': seeded })

    const config = createRunConfig({
      logger: eventHandlerState.logger,
      agent: 'base',
      prompt: 'hello',
      content: undefined,
      previousRunState: null,
      agentDefinitions: [],
      eventHandlerState,
      signal: new AbortController().signal,
    })

    const skills = await config.skillsLoader()
    expect(skills['gcloud-setup']).toEqual(seeded)
  })
})
