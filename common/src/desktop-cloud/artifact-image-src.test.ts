import { describe, expect, test } from 'bun:test'

import { isRemoteImageUrl, isSameOriginImagePath } from './artifact-image-src'
import { isSafeImageSrc } from './artifact-kinds/design'
import { setSlideImage } from './artifact-kinds/slides-ops'
import { deckSchema } from './artifact-kinds/slides'
import { isAllowedImageSrc } from './artifact-kinds/whiteboard'

const ASSET = '/_asset/0193a8f0-0000-7000-a000-000000000001'
/** Forms a browser resolves to another origin, or that could break out of an export. */
const OFF_ORIGIN = [
  '//evil.example/p.png',
  '/\\evil.example/p.png',
  '/%5Cevil.example/p.png',
  '/%5cevil.example/p.png',
  '/%2F/evil.example/p.png',
  '/ /evil.example',
  '/\tevil',
  '/x</style><img/src/onerror=alert(1)>',
  '/x"onerror="alert(1)',
]
/** What stored bodies hold today: they must stay valid (save and restore re-validate them). */
const KEPT = [ASSET, '/_blob/abc123', '/Placeholder.svg', 'https://images.example.com/a.png', 'https://example.com/a(1).png']

describe('artifact image sources (M2)', () => {
  test('a same-origin path never resolves off the origin', () => {
    for (const src of OFF_ORIGIN) expect(isSameOriginImagePath(src)).toBe(false)
    for (const src of [ASSET, '/_blob/abc123', '/Placeholder.svg']) expect(isSameOriginImagePath(src)).toBe(true)
  })

  test('a remote image is a well-formed https URL with a host and no credentials', () => {
    expect(isRemoteImageUrl('https://images.example.com/a.png')).toBe(true)
    for (const src of ['http://x.example/a.png', 'https://u:p@x.example/a', 'https:\\\\x.example', '//x.example', 'https:// x.example'])
      expect(isRemoteImageUrl(src)).toBe(false)
  })

  test('every kind validator refuses the off-origin forms and keeps what stored bodies hold', () => {
    const slide = (src: string) =>
      deckSchema.safeParse({
        version: 1,
        title: 'D',
        aspect: '16:9',
        slides: [{ id: 's', layout: 'image', title: 'T', image: { src, alt: '' } }],
      }).success
    for (const src of OFF_ORIGIN) {
      expect(isSafeImageSrc(src)).toBe(false)
      expect(isAllowedImageSrc(src)).toBe(false)
      expect(slide(src)).toBe(false)
    }
    for (const src of KEPT) {
      expect(isSafeImageSrc(src)).toBe(true)
      expect(isAllowedImageSrc(src)).toBe(true)
      expect(slide(src)).toBe(true)
    }
    const deck = deckSchema.parse({ version: 1, title: 'D', aspect: '16:9', slides: [{ id: 's', layout: 'title', title: 'T' }] })
    expect(setSlideImage(deck, 's', { src: '/\\evil.example/p.png', alt: '' })).toBe(deck)
  })
})

describe('images an agent write may introduce (only stored assets)', () => {
  const OTHER = '/_asset/0193a8f0-0000-7000-a000-000000000002'
  test('every image src in a body, by format: Markdown and HTML images in a doc, every src in a JSON kind', async () => {
    const { bodyImageSrcs } = await import('./artifact-image-src')
    expect(bodyImageSrcs('markdown', `![a](https://x.example/a.png)\n![b](${ASSET})\n<img src="/_blob/z">`)).toEqual(['https://x.example/a.png', ASSET, '/_blob/z'])
    const design = { boards: [{ root: { children: [{ type: 'image', src: 'https://x.example/h.jpg' }], fillImage: { src: ASSET } } }] }
    expect(bodyImageSrcs('json', JSON.stringify(design))).toEqual(['https://x.example/h.jpg', ASSET])
    expect(bodyImageSrcs('json', 'not json')).toEqual([])
    // A chart's data rows and a design data list's rows are the author's columns, not images.
    const chart = { slides: [{ id: 's', chart: { type: 'bar', x: 'src', series: [{ key: 'n' }], data: [{ src: 'https://x.example/a', n: 1 }] } }] }
    expect(bodyImageSrcs('json', JSON.stringify(chart))).toEqual([])
    expect(bodyImageSrcs('json', JSON.stringify({ data: [{ id: 'l', rows: [{ src: '/x' }] }] }))).toEqual([])
  })

  test('a new src must be a stored asset (or the built-in placeholder); one already stored stays, whatever it is', async () => {
    const { unstoredImageSrcsAdded } = await import('./artifact-image-src')
    const deck = (...srcs: string[]) => JSON.stringify({ slides: srcs.map((src, i) => ({ id: `s${i}`, image: { src, alt: '' } })) })
    // https, a same-origin path and the blob path are not stored assets of this artifact.
    expect(unstoredImageSrcsAdded('json', deck(), deck('https://x.example/a.png', '/_blob/abc', '/Placeholder.svg', ASSET))).toEqual(['https://x.example/a.png', '/_blob/abc'])
    // An https src the stored body already holds (a person put it there) is kept, not refused.
    expect(unstoredImageSrcsAdded('json', deck('https://x.example/a.png'), deck('https://x.example/a.png', OTHER))).toEqual([])
    // A create has no stored body: every unstored src is new.
    expect(unstoredImageSrcsAdded('markdown', null, '![x](https://x.example/a.png)')).toEqual(['https://x.example/a.png'])
  })
})
