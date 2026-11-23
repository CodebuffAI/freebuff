import { describe, expect, test } from 'bun:test'

import { safeLinkHref } from './safe-link'

test('safeLinkHref keeps web and mail links and drops every other scheme', () => {
  expect(safeLinkHref('https://example.com/a?b=1')).toBe('https://example.com/a?b=1')
  expect(safeLinkHref(' http://example.com ')).toBe('http://example.com/')
  expect(safeLinkHref('mailto:hi@example.com')).toBe('mailto:hi@example.com')
  for (const bad of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,x', 'vbscript:x', 'file:///etc/passwd', '/relative', 'example.com', '', 'java\nscript:alert(1)', null, undefined])
    expect(safeLinkHref(bad)).toBeNull()
})

// The cases each former copy (comment links, office-document links, doc links, doc paste and
// .docx export, data text blocks, sheet cell links) handled, all on the one allow-list.
describe('safeLinkHref: the one allow-list (http, https, mailto)', () => {
  test('web and mail links survive, normalised', () => {
    expect(safeLinkHref('https://freebuff.com/a?b=1')).toBe('https://freebuff.com/a?b=1')
    expect(safeLinkHref('HTTPS://Example.com/x')).toBe('https://example.com/x')
    expect(safeLinkHref(' mailto:teacher@example.com ')).toBe('mailto:teacher@example.com')
    expect(safeLinkHref('MAILTO:hi@example.com')).toBe('mailto:hi@example.com')
  })

  const unsafe = [
    'javascript:alert(1)',
    ' JavaScript:alert(1)',
    'JaVaScRiPt:alert(1)',
    '\u0000javascript:alert(1)',
    'java\tscript:alert(1)',
    'java\rscript:alert(1)',
    'javascript\u0085:alert(1)',
    'javascript\u007f:alert(1)',
    '​javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'DATA:text/html;base64,PHNjcmlwdD4=',
    'vbscript:msgbox(1)',
    'VBScript:msgbox(1)',
    'file:///etc/passwd',
    'tel:+15555550100',
    'blob:https://example.com/uuid',
    'about:blank',
    '//evil.com',
    '//evil.com/path',
    '/\\evil.com',
    '\\\\evil.com',
    'https://exa\tmple.com',
    'relative/page',
    'example.com',
    '#',
  ]

  test('every other scheme and every obfuscation is dropped', () => {
    for (const href of unsafe) expect(safeLinkHref(href)).toBeNull()
  })

  test('anchors and same-origin paths only when asked, and never a way around the list', () => {
    expect(safeLinkHref('#_Toc1234', { anchor: true })).toBe('#_Toc1234')
    expect(safeLinkHref(' #tab=abc ', { anchor: true })).toBe('#tab=abc')
    expect(safeLinkHref('#a b', { anchor: true })).toBeNull()
    expect(safeLinkHref('#_Toc1234')).toBeNull()
    expect(safeLinkHref('#_Toc1234', { path: true })).toBeNull()

    expect(safeLinkHref('/#artifact=abc', { path: true })).toBe('/#artifact=abc')
    expect(safeLinkHref('/docs/a?b=1', { path: true })).toBe('/docs/a?b=1')
    expect(safeLinkHref('/docs/a', { anchor: true })).toBeNull()
    for (const href of ['//evil.com', '/\\evil.com', '/a\\b', '/a b', '\\evil.com'])
      expect(safeLinkHref(href, { anchor: true, path: true })).toBeNull()

    for (const href of unsafe.filter((h) => h !== '#'))
      expect(safeLinkHref(href, { anchor: true, path: true })).toBeNull()
  })
})
