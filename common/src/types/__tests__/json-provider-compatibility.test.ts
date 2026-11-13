import { describe, expect, test } from 'bun:test'
import type { ToolModelMessage } from 'ai'

import type { ProviderMetadata } from '../messages/provider-metadata'

function toLocalProviderMetadata(
  options: NonNullable<ToolModelMessage['providerOptions']>,
): ProviderMetadata {
  return options
}

describe('AI SDK provider metadata compatibility', () => {
  test('accepts provider options containing nested JSON arrays and objects', () => {
    const providerOptions: NonNullable<ToolModelMessage['providerOptions']> = {
      example: {
        enabled: true,
        nested: [1, { label: 'readonly JSON value' }],
      },
    }

    expect(toLocalProviderMetadata(providerOptions)).toEqual(providerOptions)
  })
})
