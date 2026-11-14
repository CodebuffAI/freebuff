import { describe, expect, test } from 'bun:test'

import {
  TemplateCatalogError,
  cachedTemplateCatalog,
  fetchTemplateArchive,
  fetchTemplateCatalog,
  findTemplate,
  templateCatalogSchema,
  type TemplateCatalogEntry,
} from '../catalog'

const base = 'https://templates.example.test'
const entry = (overrides: Partial<TemplateCatalogEntry> = {}): TemplateCatalogEntry => ({
  id: 'saas-landing',
  name: 'SaaS landing',
  description: 'A landing page.',
  kind: 'site',
  integrations: [],
  tags: ['marketing'],
  preview: `${base}/previews/saas-landing-abc.jpg`,
  archive: {
    url: `${base}/archives/saas-landing-abc.tar.gz`,
    sha256: 'a'.repeat(64),
    bytes: 3,
    files: 2,
  },
  version: 'abc',
  ...overrides,
})
const catalog = (templates: TemplateCatalogEntry[]) => ({ version: 1, generatedAt: '2026-10-20T00:00:00Z', templates })
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('template catalogue', () => {
  test('schema accepts the published shape and rejects duplicates, extra keys and http assets', () => {
    expect(templateCatalogSchema.safeParse(catalog([entry()])).success).toBe(true)
    expect(templateCatalogSchema.safeParse(catalog([entry(), entry()])).success).toBe(false)
    expect(templateCatalogSchema.safeParse({ ...catalog([entry()]), extra: true }).success).toBe(false)
    expect(templateCatalogSchema.safeParse(catalog([entry({ preview: 'http://templates.example.test/p.jpg' })])).success).toBe(false)
    expect(templateCatalogSchema.safeParse(catalog([entry({ id: 'Not Valid' })])).success).toBe(false)
  })

  test('fetch validates the body and refuses assets on another origin', async () => {
    const url = `${base}/catalog.json`
    const good = await fetchTemplateCatalog({ url, fetcher: async () => json(catalog([entry()])) })
    expect(good.templates.map((t) => t.id)).toEqual(['saas-landing'])
    expect(findTemplate(good, 'saas-landing').name).toBe('SaaS landing')
    expect(() => findTemplate(good, 'missing')).toThrow(TemplateCatalogError)

    const elsewhere = entry({ archive: { ...entry().archive, url: 'https://evil.example.test/a.tar.gz' } })
    await expect(fetchTemplateCatalog({ url, fetcher: async () => json(catalog([elsewhere])) })).rejects.toThrow('another origin')
    await expect(fetchTemplateCatalog({ url, fetcher: async () => json({ nope: true }) })).rejects.toThrow('invalid')
    await expect(fetchTemplateCatalog({ url, fetcher: async () => json({}, 500) })).rejects.toThrow('500')
    const down = fetchTemplateCatalog({
      url,
      fetcher: async () => {
        throw new Error('offline')
      },
    })
    await expect(down).rejects.toMatchObject({ status: 503 })
  })

  test('cached catalogue shares one fetch within its ttl and refetches after it', async () => {
    let fetches = 0
    let clock = 0
    const cached = cachedTemplateCatalog({
      url: `${base}/catalog.json`,
      fetcher: async () => {
        fetches += 1
        return json(catalog([entry()]))
      },
      ttlMs: 1000,
      now: () => clock,
    })
    await Promise.all([cached(), cached()])
    expect(fetches).toBe(1)
    clock = 500
    await cached()
    expect(fetches).toBe(1)
    clock = 1500
    await cached()
    expect(fetches).toBe(2)
  })

  test('archive download is checked against the catalogue’s size and digest', async () => {
    const bytes = new TextEncoder().encode('abc')
    const sha256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    const template = entry({ archive: { ...entry().archive, sha256, bytes: 3 } })
    const fetcher = async () => new Response(bytes)
    expect(await fetchTemplateArchive(template, { fetcher })).toEqual(bytes)
    await expect(fetchTemplateArchive(entry({ archive: { ...template.archive, bytes: 4 } }), { fetcher })).rejects.toThrow('size')
    await expect(fetchTemplateArchive(entry(), { fetcher })).rejects.toThrow('checksum')
    await expect(fetchTemplateArchive(template, { fetcher: async () => new Response('', { status: 404 }) })).rejects.toThrow('404')
  })
})
