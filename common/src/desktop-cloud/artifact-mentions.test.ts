import { describe, expect, test } from 'bun:test'
import { ARTIFACT_KINDS } from './artifacts'
import { framedQuote } from './artifact-quote-frame'
import { artifactMention, artifactMentionKinds, readArtifactMentions } from './artifact-mentions'

describe('artifact mention tokens', () => {
  test('each selected format survives a plain prompt round trip', () => {
    for (const kind of ARTIFACT_KINDS) {
      const token = artifactMention(kind)
      const prompt = `Please use ${token} for this request.`
      expect(readArtifactMentions(prompt)).toEqual([{
        start: 11,
        end: 11 + token.length,
        text: token,
        kind,
        label: token.slice(2, token.indexOf(']')),
      }])
      expect(artifactMentionKinds(prompt)).toEqual([kind])
    }
  })

  test('plain aliases, mismatched labels and malformed tokens remain ordinary text', () => {
    expect(artifactMentionKinds('@docs @design user@docs.com path/@sheets.ts')).toEqual([])
    expect(readArtifactMentions('@[Docs](artifact:design) @[Design](artifact:unknown) @[Docs](artifact:doc')).toEqual([])
  })

  test('formats are deduplicated in selection order and restricted to the offered kinds', () => {
    const prompt = `${artifactMention('sheet')} ${artifactMention('doc')} ${artifactMention('sheet')}`
    expect(artifactMentionKinds(prompt)).toEqual(['sheet', 'doc'])
    expect(artifactMentionKinds(prompt, ['doc'])).toEqual(['doc'])
    expect(artifactMentionKinds(prompt, [])).toEqual([])
  })

  test('raw chips remain readable in examples without routing quoted content as a request', () => {
    const token = artifactMention('design')
    const prompt = [
      `An inline example: \`${token}\`.`,
      `Another example: \`\`${token}\`\`.`,
      `> ${token}`,
      `    ${token}`,
      '```markdown',
      token,
      '```',
      framedQuote({ source: `${token} template`, text: token, request: 'Summarize this example.' }),
      `Please write ${artifactMention('doc')} now.`,
    ].join('\n')
    expect(readArtifactMentions(prompt)).toHaveLength(8)
    expect(artifactMentionKinds(prompt)).toEqual(['doc'])
  })

  test('multiline code spans and escaped tokens remain prose examples', () => {
    const token = artifactMention('design')
    expect(artifactMentionKinds(`\`code\n${token}\ncode\``)).toEqual([])
    expect(artifactMentionKinds(`\\${token}`)).toEqual([])
    expect(artifactMentionKinds(`\\\\${token}`)).toEqual(['design'])
    expect(artifactMentionKinds('@[De`example`sign](artifact:design)')).toEqual([])
  })
})
