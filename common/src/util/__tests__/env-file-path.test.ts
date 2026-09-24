import { describe, expect, test } from 'bun:test'

import {
  ENV_TEMPLATE_FILE_PATTERNS,
  isEnvFilePath,
  isEnvTemplateFilePath,
  isSensitiveEnvFilePath,
} from '../env-file-path'

describe('env file paths', () => {
  test.each([
    ['.env', true],
    ['.ENV.LOCAL', true],
    ['config/.Env.Template', true],
    ['app.env', false],
  ])('%s env family → %s', (filePath, expected) => {
    expect(isEnvFilePath(filePath)).toBe(expected)
  })

  test.each([
    ['.env', true],
    ['.ENV', true],
    ['config/.env.local', true],
    ['config\\.Env.Production', true],
    ['.ENV/', true],
    ['config/.env.local/.', true],
    ['safe/../.env', true],
    ['.env ', true],
    ['.env:$DATA', true],
    ['config/.env.local:backup', true],
    ['C:.ENV', true],
    ['.env.example ', true],
    ['.env.example:$DATA', true],
    ['/tmp/.env.example', false],
    ['.ENV.SAMPLE', false],
    ['config\\.env.Template', false],
    ['.envrc', false],
    ['app.env', false],
    ['.env/..', false],
    // Only the exact template names are templates: a scoped copy is where
    // real values get pasted, so it stays sensitive.
    ['.env.local.example', true],
    ['apps/web/.env.production.example', true],
    ['.env.example.local', true],
    ['.env.local.example.', true],
    ['.env.local.example:$DATA', true],
    ['.env.local:x.example', true],
    ['.env..example', true],
  ])('%s sensitive → %s', (filePath, expected) => {
    expect(isSensitiveEnvFilePath(filePath)).toBe(expected)
  })

  test.each([
    ['.env.example', true],
    ['.ENV.SAMPLE', true],
    ['config/.Env.Template', true],
    ['config/.Env.Template/./', true],
    ['C:.Env.Example', true],
    ['.env.local.example', false],
    ['config\\.ENV.Production.Example', false],
    ['.env', false],
    ['.env.local', false],
    ['.env.example ', false],
    ['.env.example:$DATA', false],
    ['app.env.example', false],
    ['.env.example.local', false],
    ['.env.local.example ', false],
    ['.env.local:x.example', false],
    ['.env..example', false],
    ['.env.local.sample', false],
  ])('%s template → %s', (filePath, expected) => {
    expect(isEnvTemplateFilePath(filePath)).toBe(expected)
  })

  // The glob list is what Desktop writes into an ignore file; the matcher is
  // what everything else calls. Every literal entry satisfies the matcher; the
  // one glob is un-ignored there only, so a scoped copy stays sensitive.
  test('every literal pattern is a template by the matcher, and the glob is not', () => {
    for (const pattern of ENV_TEMPLATE_FILE_PATTERNS) {
      const name = pattern.replace('*', 'local')
      expect(isEnvTemplateFilePath(name), name).toBe(!pattern.includes('*'))
    }
  })
})
