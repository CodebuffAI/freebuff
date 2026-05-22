import { describe, expect, test, beforeEach, afterEach } from 'bun:test'

import {
  applyLocalAction,
  DEFAULT_LOCAL_BASE_URL,
  getActiveLocalBaseUrl,
  getActiveLocalModel,
  parseLocalArgs,
} from '../local-provider'

describe('parseLocalArgs — basic shapes', () => {
  test('empty args → status', () => {
    expect(parseLocalArgs('').kind).toBe('status')
    expect(parseLocalArgs('   ').kind).toBe('status')
    expect(parseLocalArgs('\t\n').kind).toBe('status')
  })

  test('"status" → status', () => {
    expect(parseLocalArgs('status').kind).toBe('status')
    expect(parseLocalArgs('  status  ').kind).toBe('status')
    expect(parseLocalArgs('STATUS').kind).toBe('status')
  })

  test('"list" / "models" → list', () => {
    expect(parseLocalArgs('list').kind).toBe('list')
    expect(parseLocalArgs('models').kind).toBe('list')
  })

  test('"off" → disable', () => {
    expect(parseLocalArgs('off').kind).toBe('disable')
    expect(parseLocalArgs('disable').kind).toBe('disable')
  })

  test('"off" with stray args → invalid', () => {
    const r = parseLocalArgs('off http://oops')
    expect(r.kind).toBe('invalid')
  })

  test('unknown subcommand → invalid', () => {
    const r = parseLocalArgs('foobar')
    expect(r.kind).toBe('invalid')
    if (r.kind === 'invalid') expect(r.reason).toContain('Unknown')
  })
})

describe('parseLocalArgs — enable shapes', () => {
  test('"on" → enable with default URL, no model', () => {
    const r = parseLocalArgs('on')
    expect(r.kind).toBe('enable')
    if (r.kind === 'enable') {
      expect(r.baseUrl).toBe(DEFAULT_LOCAL_BASE_URL)
      expect(r.model).toBeUndefined()
    }
  })

  test('"on <url>" → enable with URL only', () => {
    const r = parseLocalArgs('on http://localhost:1234/v1')
    expect(r.kind).toBe('enable')
    if (r.kind === 'enable') {
      expect(r.baseUrl).toBe('http://localhost:1234/v1')
      expect(r.model).toBeUndefined()
    }
  })

  test('"on <model>" (model only, no URL) → enable with default URL + model', () => {
    const r = parseLocalArgs('on llama3.1:8b')
    expect(r.kind).toBe('enable')
    if (r.kind === 'enable') {
      expect(r.baseUrl).toBe(DEFAULT_LOCAL_BASE_URL)
      expect(r.model).toBe('llama3.1:8b')
    }
  })

  test('"on <url> <model>" → both set', () => {
    const r = parseLocalArgs('on http://localhost:1234/v1 llama3.1:8b')
    expect(r.kind).toBe('enable')
    if (r.kind === 'enable') {
      expect(r.baseUrl).toBe('http://localhost:1234/v1')
      expect(r.model).toBe('llama3.1:8b')
    }
  })

  test('"enable <url>" and "set <model>" aliases work', () => {
    const a = parseLocalArgs('enable http://x:1/v1')
    expect(a.kind).toBe('enable')
    const b = parseLocalArgs('set gemma4:e2b')
    expect(b.kind).toBe('enable')
    if (b.kind === 'enable') expect(b.model).toBe('gemma4:e2b')
  })

  test('bare URL → enable', () => {
    const r = parseLocalArgs('http://localhost:11434/v1')
    expect(r.kind).toBe('enable')
    if (r.kind === 'enable') expect(r.baseUrl).toBe('http://localhost:11434/v1')
  })

  test('bare model tag → enable with default URL + model', () => {
    const r = parseLocalArgs('llama3.1:8b')
    expect(r.kind).toBe('enable')
    if (r.kind === 'enable') {
      expect(r.baseUrl).toBe(DEFAULT_LOCAL_BASE_URL)
      expect(r.model).toBe('llama3.1:8b')
    }
  })

  test('non-http URL → invalid', () => {
    const r = parseLocalArgs('on ftp://localhost')
    expect(r.kind).toBe('invalid')
  })

  test('malformed URL → invalid', () => {
    const r = parseLocalArgs('on http://')
    expect(r.kind).toBe('invalid')
  })

  test('https URL accepted', () => {
    const r = parseLocalArgs('on https://my-vm.example.com:8080/v1 llama3.1:8b')
    expect(r.kind).toBe('enable')
    if (r.kind === 'enable')
      expect(r.baseUrl).toBe('https://my-vm.example.com:8080/v1')
  })
})

describe('parseLocalArgs — model subcommand', () => {
  test('"model <name>" → set-model', () => {
    const r = parseLocalArgs('model llama3.1:8b')
    expect(r.kind).toBe('set-model')
    if (r.kind === 'set-model') expect(r.model).toBe('llama3.1:8b')
  })

  test('"model clear" / "model off" / "model none" → clear-model', () => {
    expect(parseLocalArgs('model clear').kind).toBe('clear-model')
    expect(parseLocalArgs('model off').kind).toBe('clear-model')
    expect(parseLocalArgs('model none').kind).toBe('clear-model')
  })

  test('"model" without name → invalid', () => {
    const r = parseLocalArgs('model')
    expect(r.kind).toBe('invalid')
  })

  test('"model <flag>" → invalid', () => {
    const r = parseLocalArgs('model --x')
    expect(r.kind).toBe('invalid')
  })
})

describe('applyLocalAction (side effects on process.env)', () => {
  let originalBaseUrl: string | undefined
  let originalApiKey: string | undefined
  let originalModel: string | undefined

  beforeEach(() => {
    originalBaseUrl = process.env.CODEBUFF_BASE_URL
    originalApiKey = process.env.CODEBUFF_PROVIDER_API_KEY
    originalModel = process.env.CODEBUFF_PROVIDER_MODEL
    delete process.env.CODEBUFF_BASE_URL
    delete process.env.CODEBUFF_PROVIDER_API_KEY
    delete process.env.CODEBUFF_PROVIDER_MODEL
  })

  afterEach(() => {
    if (originalBaseUrl === undefined) delete process.env.CODEBUFF_BASE_URL
    else process.env.CODEBUFF_BASE_URL = originalBaseUrl
    if (originalApiKey === undefined)
      delete process.env.CODEBUFF_PROVIDER_API_KEY
    else process.env.CODEBUFF_PROVIDER_API_KEY = originalApiKey
    if (originalModel === undefined) delete process.env.CODEBUFF_PROVIDER_MODEL
    else process.env.CODEBUFF_PROVIDER_MODEL = originalModel
  })

  test('enable without model sets baseUrl, clears any previous model override', async () => {
    process.env.CODEBUFF_PROVIDER_MODEL = 'stale-model'
    const msg = await applyLocalAction({
      kind: 'enable',
      baseUrl: 'http://localhost:11434/v1',
    })
    expect(process.env.CODEBUFF_BASE_URL).toBe('http://localhost:11434/v1')
    expect(process.env.CODEBUFF_PROVIDER_MODEL).toBeUndefined()
    expect(msg).toContain('ON')
    expect(msg).toContain('No model override')
    expect(msg).toContain('llama3.1:8b')
  })

  test('enable with model sets both env vars', async () => {
    const msg = await applyLocalAction({
      kind: 'enable',
      baseUrl: 'http://localhost:11434/v1',
      model: 'llama3.1:8b',
    })
    expect(process.env.CODEBUFF_BASE_URL).toBe('http://localhost:11434/v1')
    expect(process.env.CODEBUFF_PROVIDER_MODEL).toBe('llama3.1:8b')
    expect(msg).toContain('Model override: llama3.1:8b')
  })

  test('set-model when local is OFF → error', async () => {
    const msg = await applyLocalAction({
      kind: 'set-model',
      model: 'llama3.1:8b',
    })
    expect(process.env.CODEBUFF_PROVIDER_MODEL).toBeUndefined()
    expect(msg).toContain('OFF')
  })

  test('set-model when local is ON → updates model', async () => {
    process.env.CODEBUFF_BASE_URL = 'http://localhost:11434/v1'
    const msg = await applyLocalAction({
      kind: 'set-model',
      model: 'llama3.1:8b',
    })
    expect(process.env.CODEBUFF_PROVIDER_MODEL).toBe('llama3.1:8b')
    expect(msg).toContain('Model override: llama3.1:8b')
  })

  test('clear-model removes only the model, keeps baseUrl', async () => {
    process.env.CODEBUFF_BASE_URL = 'http://localhost:11434/v1'
    process.env.CODEBUFF_PROVIDER_MODEL = 'llama3.1:8b'
    const msg = await applyLocalAction({ kind: 'clear-model' })
    expect(process.env.CODEBUFF_BASE_URL).toBe('http://localhost:11434/v1')
    expect(process.env.CODEBUFF_PROVIDER_MODEL).toBeUndefined()
    expect(msg).toContain('cleared')
  })

  test('clear-model when none set is friendly', async () => {
    const msg = await applyLocalAction({ kind: 'clear-model' })
    expect(msg).toContain('No model override')
  })

  test('disable clears baseUrl, apiKey, and model', async () => {
    process.env.CODEBUFF_BASE_URL = 'http://localhost:11434/v1'
    process.env.CODEBUFF_PROVIDER_API_KEY = 'ollama'
    process.env.CODEBUFF_PROVIDER_MODEL = 'llama3.1:8b'
    const msg = await applyLocalAction({ kind: 'disable' })
    expect(process.env.CODEBUFF_BASE_URL).toBeUndefined()
    expect(process.env.CODEBUFF_PROVIDER_API_KEY).toBeUndefined()
    expect(process.env.CODEBUFF_PROVIDER_MODEL).toBeUndefined()
    expect(msg).toContain('OFF')
    expect(msg).toContain('llama3.1:8b')
  })

  test('disable when already off → idempotent', async () => {
    const msg = await applyLocalAction({ kind: 'disable' })
    expect(msg).toContain('already OFF')
  })

  test('status when off mentions /local list and shows usage', async () => {
    const msg = await applyLocalAction({ kind: 'status' })
    expect(msg).toContain('OFF')
    expect(msg).toContain('/local list')
  })

  test('status when on with model shows both URL and model', async () => {
    process.env.CODEBUFF_BASE_URL = 'http://localhost:1234/v1'
    process.env.CODEBUFF_PROVIDER_MODEL = 'llama3.1:8b'
    const msg = await applyLocalAction({ kind: 'status' })
    expect(msg).toContain('ON')
    expect(msg).toContain('http://localhost:1234/v1')
    expect(msg).toContain('llama3.1:8b')
  })

  test('status when on without model warns about no model override', async () => {
    process.env.CODEBUFF_BASE_URL = 'http://localhost:11434/v1'
    const msg = await applyLocalAction({ kind: 'status' })
    expect(msg).toContain('ON')
    expect(msg).toContain('(none')
  })

  test('invalid returns reason prefixed', async () => {
    const msg = await applyLocalAction({
      kind: 'invalid',
      reason: 'something wrong',
    })
    expect(msg).toContain('something wrong')
  })

  test('list when off returns error', async () => {
    const msg = await applyLocalAction({ kind: 'list' })
    expect(msg).toContain('OFF')
  })
})

describe('parseLocalArgs + applyLocalAction end-to-end', () => {
  let originalBaseUrl: string | undefined
  let originalModel: string | undefined

  beforeEach(() => {
    originalBaseUrl = process.env.CODEBUFF_BASE_URL
    originalModel = process.env.CODEBUFF_PROVIDER_MODEL
    delete process.env.CODEBUFF_BASE_URL
    delete process.env.CODEBUFF_PROVIDER_MODEL
  })

  afterEach(() => {
    if (originalBaseUrl === undefined) delete process.env.CODEBUFF_BASE_URL
    else process.env.CODEBUFF_BASE_URL = originalBaseUrl
    if (originalModel === undefined) delete process.env.CODEBUFF_PROVIDER_MODEL
    else process.env.CODEBUFF_PROVIDER_MODEL = originalModel
  })

  test('user types `/local on llama3.1:8b` → URL default + model set', async () => {
    await applyLocalAction(parseLocalArgs('on llama3.1:8b'))
    expect(process.env.CODEBUFF_BASE_URL).toBe(DEFAULT_LOCAL_BASE_URL)
    expect(process.env.CODEBUFF_PROVIDER_MODEL).toBe('llama3.1:8b')
  })

  test('user types `/local llama3.1:8b` (no `on`) → same effect', async () => {
    await applyLocalAction(parseLocalArgs('llama3.1:8b'))
    expect(process.env.CODEBUFF_BASE_URL).toBe(DEFAULT_LOCAL_BASE_URL)
    expect(process.env.CODEBUFF_PROVIDER_MODEL).toBe('llama3.1:8b')
  })

  test('user types `/local on http://x/v1 llama3.1:8b` → both set', async () => {
    await applyLocalAction(parseLocalArgs('on http://x.example.com:9999/v1 llama3.1:8b'))
    expect(process.env.CODEBUFF_BASE_URL).toBe('http://x.example.com:9999/v1')
    expect(process.env.CODEBUFF_PROVIDER_MODEL).toBe('llama3.1:8b')
  })

  test('user types `/local model llama3.1:8b` after `/local on` → model added', async () => {
    await applyLocalAction(parseLocalArgs('on'))
    expect(process.env.CODEBUFF_PROVIDER_MODEL).toBeUndefined()
    await applyLocalAction(parseLocalArgs('model llama3.1:8b'))
    expect(process.env.CODEBUFF_PROVIDER_MODEL).toBe('llama3.1:8b')
  })

  test('user types `/local off` → both cleared', async () => {
    await applyLocalAction(parseLocalArgs('on llama3.1:8b'))
    await applyLocalAction(parseLocalArgs('off'))
    expect(process.env.CODEBUFF_BASE_URL).toBeUndefined()
    expect(process.env.CODEBUFF_PROVIDER_MODEL).toBeUndefined()
  })

  test('mutations are visible via getter functions', async () => {
    await applyLocalAction(parseLocalArgs('on llama3.1:8b'))
    expect(getActiveLocalBaseUrl()).toBe(DEFAULT_LOCAL_BASE_URL)
    expect(getActiveLocalModel()).toBe('llama3.1:8b')
  })

  test('re-enabling without model clears previous model override', async () => {
    await applyLocalAction(parseLocalArgs('on llama3.1:8b'))
    await applyLocalAction(parseLocalArgs('on'))
    expect(getActiveLocalBaseUrl()).toBe(DEFAULT_LOCAL_BASE_URL)
    expect(getActiveLocalModel()).toBeUndefined()
  })
})
