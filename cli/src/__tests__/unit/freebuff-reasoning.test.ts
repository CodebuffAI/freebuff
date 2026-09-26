import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
  getFreebuffModelDefaultEffort,
} from '@codebuff/common/constants/freebuff-models'
import {
  useFreebuffModelStore,
  getFreebuffReasoningEffortForModel,
  getEffectiveFreebuffReasoningEffort,
} from '../../state/freebuff-model-store'

const previous = useFreebuffModelStore.getState().reasoningEffortByModel
afterEach(() =>
  useFreebuffModelStore.setState({ reasoningEffortByModel: previous }),
)

describe('per-model reasoning', () => {
  const model = FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID
  test('uses the catalog default without sending an override', () => {
    useFreebuffModelStore.setState({ reasoningEffortByModel: {} })
    expect(getFreebuffReasoningEffortForModel(model)).toBeNull()
    expect(getEffectiveFreebuffReasoningEffort(model)).toBe(
      getFreebuffModelDefaultEffort(model),
    )
  })
  test('uses supported overrides and ignores stale unsupported levels', () => {
    useFreebuffModelStore.setState({
      reasoningEffortByModel: { [model]: 'low' },
    })
    expect(getFreebuffReasoningEffortForModel(model)).toBe('low')
    useFreebuffModelStore.setState({
      reasoningEffortByModel: { [model]: 'xhigh' },
    })
    expect(getFreebuffReasoningEffortForModel(model)).toBeNull()
  })
})

/**
 * The send path, asserted by reading the source for the same reason the runner's
 * effortForwarding test does: an absent metadata field IS how "use the default"
 * is expressed, so a dropped value is invisible to every other test.
 */
describe('the CLI turn carries the chosen effort', () => {
  const source = readFileSync(
    join(import.meta.dir, '..', '..', 'hooks', 'use-send-message.ts'),
    'utf8',
  )

  test('it reaches extraCodebuffMetadata under the name the server reads', () => {
    const metadata = source.slice(source.indexOf('extraCodebuffMetadata:'))
    expect(metadata).toContain('freebuff_reasoning_effort')
    expect(metadata).toContain('freebuffReasoningEffort')
  })
})
