import { Buffer } from 'node:buffer'

/** Chat text is data, but Render's WAF can mistake it for executable commands.
 * The mirror server unwraps this UTF-8 JSON envelope after authentication.
 * This is transport encoding, not encryption. Deploy the decoder first. */
export function encodeMirrorRequest(body: unknown): string {
  return JSON.stringify({
    encoding: 'base64',
    data: Buffer.from(JSON.stringify(body), 'utf8').toString('base64'),
  })
}
