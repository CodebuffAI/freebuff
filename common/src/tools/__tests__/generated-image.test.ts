import { describe, expect, test } from 'bun:test'

import { generatedImageFromOutput } from '../generated-image'

const image = { url: 'https://images.luminal.cloud/out/a.webp', width: 1344, height: 768 }

describe('generatedImageFromOutput', () => {
  test('reads the runtime array and its JSON text alike', () => {
    const output = [{ type: 'json', value: image }]
    expect(generatedImageFromOutput(output)).toEqual(image)
    expect(generatedImageFromOutput(JSON.stringify(output))).toEqual(image)
  })

  // Transcripts load this URL without the opt-in remote images need.
  test('only an https URL is an image', () => {
    for (const url of ['http://example.com/a.png', 'javascript:alert(1)', 'data:image/png;base64,AA', 'not a url'])
      expect(generatedImageFromOutput([{ type: 'json', value: { ...image, url } }])).toBeNull()
    expect(generatedImageFromOutput([{ type: 'json', value: { errorMessage: 'limit reached' } }])).toBeNull()
    expect(generatedImageFromOutput('{oops')).toBeNull()
    // A local dev server's own link.
    const local = { ...image, url: 'http://localhost:3000/api/v1/generate-image/x.jpg' }
    expect(generatedImageFromOutput([{ type: 'json', value: local }])).toEqual(local)
  })
})
