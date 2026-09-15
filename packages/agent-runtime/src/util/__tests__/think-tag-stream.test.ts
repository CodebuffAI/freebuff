import { describe, expect, it } from 'bun:test'

import {
  historyHasUnclosedOpen,
  historyLeaksThinkTags,
  IMPLICIT_OPEN_BUDGET_CHARS,
  stripThinkScaffolding,
  ThinkTagStream,
} from '../think-tag-stream'

import type { ThinkStreamSegment } from '../think-tag-stream'

/** Feed the deltas one at a time, then flush — the shape a real stream has. */
function run(
  deltas: string[],
  options?: { implicitOpen?: boolean; holdExplicitOpens?: boolean },
): ThinkStreamSegment[] {
  const stream = new ThinkTagStream(options)
  const out: ThinkStreamSegment[] = []
  for (const delta of deltas) out.push(...stream.push(delta))
  out.push(...stream.flush())
  return out
}

const joined = (segments: ThinkStreamSegment[], type: 'text' | 'reasoning') =>
  segments
    .filter((s) => s.type === type)
    .map((s) => s.text)
    .join('')

/** Split into single characters — the worst case for tag detection. */
const chars = (text: string) => [...text]

describe('ThinkTagStream — paired tags', () => {
  it('routes a paired block to reasoning and keeps the answer as text', () => {
    const out = run(['<think>plan it</think>Here is the answer.'])
    expect(out).toEqual([
      { type: 'reasoning', text: 'plan it' },
      { type: 'text', text: 'Here is the answer.' },
    ])
  })

  it('never emits a tag as text, however the deltas are split', () => {
    const out = run(chars('before<think>thought</think>after'))
    expect(joined(out, 'text')).toBe('beforeafter')
    expect(joined(out, 'reasoning')).toBe('thought')
  })

  it('holds a trailing partial tag rather than emitting it', () => {
    const stream = new ThinkTagStream()
    expect(stream.push('answer</thi')).toEqual([
      { type: 'text', text: 'answer' },
    ])
    expect(stream.push('nk>tail')).toEqual([{ type: 'text', text: 'tail' }])
  })

  it('releases a partial tag that never completed as ordinary text', () => {
    // Segments merge within one push, not across them — so compare the text.
    expect(joined(run(['a < b']), 'text')).toBe('a < b')
    expect(joined(run(['ends with <']), 'text')).toBe('ends with <')
  })

  it('streams an unclosed open as reasoning on a clean lane, live like rule 1', () => {
    // Default lane: a bare open is near-certainly a real block (truncated
    // thought). Streaming it live keeps the zero-latency main behavior —
    // the review's concern was exactly this trace freezing until a close.
    const out = run(['<think>truncated thou', 'ght'])
    expect(joined(out, 'reasoning')).toBe('truncated thought')
    expect(joined(out, 'text')).toBe('')
  })

  it('keeps an answer quoted around a prose open tag as text when armed', () => {
    // History-proven lane (an open was left unclosed before): the hold is
    // armed, so a quoted tag cannot swallow the answer into the thinking box.
    const out = run(
      ['Write <think> ', 'like this in your docs. The answer continues here.'],
      { holdExplicitOpens: true },
    )
    expect(joined(out, 'reasoning')).toBe('')
    expect(joined(out, 'text')).toBe(
      'Write  like this in your docs. The answer continues here.',
    )
  })

  it('holds an explicit open only until its close arrives, when armed', () => {
    const stream = new ThinkTagStream({ holdExplicitOpens: true })
    expect(stream.push('Answer part one. <think>plan it')).toEqual([
      { type: 'text', text: 'Answer part one. ' },
    ])
    expect(stream.push('</think>Here is the answer.')).toEqual([
      { type: 'reasoning', text: 'plan it' },
      { type: 'text', text: 'Here is the answer.' },
    ])
  })

  it('releases an armed hold past the budget as text, and the rest streams live', () => {
    // Same give-up as the implicit head: past the budget the step is
    // answering, not thinking — a quoted tag with a long answer after it
    // must not be swallowed (issue #1155, bug 2).
    const stream = new ThinkTagStream({ holdExplicitOpens: true })
    const long = 'x'.repeat(IMPLICIT_OPEN_BUDGET_CHARS)
    expect(stream.push(`Answer <think>${long}`)).toEqual([
      { type: 'text', text: 'Answer ' },
      { type: 'text', text: long },
    ])
    expect(stream.push(' still answering')).toEqual([
      { type: 'text', text: ' still answering' },
    ])
    // Disarmed: a later marker is stripped, not treated as a close.
    expect(stream.push('</think>tail')).toEqual([
      { type: 'text', text: 'tail' },
    ])
  })

  it('streams a long well-formed trace per-delta on a clean lane, never buffered', () => {
    // The review's measurement: a DeepSeek-R1-style trace must not wait for
    // its close. One push in, everything so far is already out.
    const stream = new ThinkTagStream()
    const long = 'x'.repeat(5000)
    expect(stream.push(`<think>${long}`)).toEqual([
      { type: 'reasoning', text: long },
    ])
    expect(stream.push(' still going')).toEqual([
      { type: 'reasoning', text: ' still going' },
    ])
    expect(stream.push('</think>answer')).toEqual([
      { type: 'text', text: 'answer' },
    ])
  })

  it('flushes a clean-lane unclosed block tail as reasoning', () => {
    const stream = new ThinkTagStream()
    expect(stream.push('<think>thought</thi')).toEqual([
      { type: 'reasoning', text: 'thought' },
    ])
    expect(stream.flush()).toEqual([{ type: 'reasoning', text: '</thi' }])
  })

  it('keeps the implicit head release as text at the shared budget', () => {
    const stream = new ThinkTagStream({ implicitOpen: true })
    const long = 'x'.repeat(IMPLICIT_OPEN_BUDGET_CHARS)
    expect(stream.push(long)).toEqual([{ type: 'text', text: long }])
    expect(stream.push('</think>tail')).toEqual([
      { type: 'text', text: 'tail' },
    ])
  })

  it('releases an explicit open on a native reasoning chunk as text, when armed', () => {
    const stream = new ThinkTagStream({ holdExplicitOpens: true })
    expect(stream.push('A <think> quoted open')).toEqual([
      { type: 'text', text: 'A ' },
    ])
    expect(stream.disarmImplicitOpen()).toEqual([
      { type: 'text', text: ' quoted open' },
    ])
    expect(stream.push(' and the answer continues')).toEqual([
      { type: 'text', text: ' and the answer continues' },
    ])
  })
})
describe('ThinkTagStream — orphan close, not armed', () => {
  // The default for every non-leaking model: the prose is not reclassified
  // (it already streamed), but the bare marker must never reach a transcript.
  it('strips the marker and keeps surrounding prose as text', () => {
    const out = run(['Saw the anchor.</think>Now find the splitter.'])
    expect(out).toEqual([
      { type: 'text', text: 'Saw the anchor.Now find the splitter.' },
    ])
  })

  it('strips a marker arriving on its own delta', () => {
    const out = run(['done', '</think>', ' more'])
    expect(joined(out, 'text')).toBe('done more')
    expect(joined(out, 'reasoning')).toBe('')
  })
})

describe('ThinkTagStream — orphan close, armed', () => {
  it('reclassifies the head as reasoning once the marker lands', () => {
    const out = run(
      [
        'Ключевая зацепка: the bundle knows the type.',
        'Do that.</think>Real answer.',
      ],
      { implicitOpen: true },
    )
    expect(out).toEqual([
      {
        type: 'reasoning',
        text: 'Ключевая зацепка: the bundle knows the type.Do that.',
      },
      { type: 'text', text: 'Real answer.' },
    ])
  })

  it('emits nothing until the marker settles the head', () => {
    const stream = new ThinkTagStream({ implicitOpen: true })
    expect(stream.push('still thinking')).toEqual([])
    expect(stream.push('</think>answer')).toEqual([
      { type: 'reasoning', text: 'still thinking' },
      { type: 'text', text: 'answer' },
    ])
  })

  it('closes the implicit block only once; later markers are stripped', () => {
    const out = run(['think</think>answer</think>tail'], { implicitOpen: true })
    expect(out).toEqual([
      { type: 'reasoning', text: 'think' },
      { type: 'text', text: 'answertail' },
    ])
  })

  it('releases the head as text when no marker ever arrives', () => {
    // The lossless guarantee: a wrong guess delays the answer, never hides it.
    const out = run(['A plain answer with no tags at all.'], {
      implicitOpen: true,
    })
    expect(out).toEqual([
      { type: 'text', text: 'A plain answer with no tags at all.' },
    ])
  })

  it('gives up past the budget and streams the rest as text', () => {
    const stream = new ThinkTagStream({ implicitOpen: true })
    const long = 'x'.repeat(IMPLICIT_OPEN_BUDGET_CHARS)
    expect(stream.push(long)).toEqual([{ type: 'text', text: long }])
    expect(stream.push(' and more')).toEqual([
      { type: 'text', text: ' and more' },
    ])
    // Disarmed: a later marker is stripped, not treated as a close.
    expect(stream.push('</think>tail')).toEqual([
      { type: 'text', text: 'tail' },
    ])
  })

  it('disarms on a native reasoning chunk and releases the head as text', () => {
    const stream = new ThinkTagStream({ implicitOpen: true })
    expect(stream.push('the answer begins')).toEqual([])
    expect(stream.disarmImplicitOpen()).toEqual([
      { type: 'text', text: 'the answer begins' },
    ])
    expect(stream.push(' and continues')).toEqual([
      { type: 'text', text: ' and continues' },
    ])
  })

  it('still honours an explicit open tag while armed', () => {
    const out = run(['<think>explicit</think>answer'], { implicitOpen: true })
    expect(out).toEqual([
      { type: 'reasoning', text: 'explicit' },
      { type: 'text', text: 'answer' },
    ])
  })
})

describe('historyLeaksThinkTags', () => {
  const assistant = (text: string) => ({
    role: 'assistant',
    content: [{ type: 'text', text }],
  })

  it('is false for a clean history', () => {
    expect(historyLeaksThinkTags([])).toBe(false)
    expect(historyLeaksThinkTags([assistant('a normal answer')])).toBe(false)
  })

  it('is false when every block is properly paired', () => {
    expect(historyLeaksThinkTags([assistant('<think>x</think>answer')])).toBe(
      false,
    )
  })

  it('is true for an orphan close left in visible content', () => {
    expect(historyLeaksThinkTags([assistant('thought</think>answer')])).toBe(
      true,
    )
  })

  it('ignores user messages and non-text parts', () => {
    expect(
      historyLeaksThinkTags([
        { role: 'user', content: [{ type: 'text', text: 'why </think>?' }] },
        {
          role: 'assistant',
          content: [{ type: 'reasoning', text: '</think>' }],
        },
      ]),
    ).toBe(false)
  })
})

describe('stripThinkScaffolding', () => {
  it('removes paired blocks, unclosed opens and orphan closes', () => {
    expect(stripThinkScaffolding('<think>x</think>answer')).toBe('answer')
    expect(stripThinkScaffolding('answer<think>truncated')).toBe('answer')
    expect(stripThinkScaffolding('thought</think>answer')).toBe('thoughtanswer')
  })

  it('leaves surrounding whitespace alone, unlike stripThinkTags', () => {
    expect(stripThinkScaffolding('  spaced  ')).toBe('  spaced  ')
    expect(stripThinkScaffolding('a\n\n<think>x</think>\n\nb')).toBe(
      'a\n\n\n\nb',
    )
  })
})

describe('historyLeaksThinkTags — head window', () => {
  it('ignores a marker quoted deep in a long reply', () => {
    // A bug report about think tags is not evidence that this lane leaks.
    const quoted =
      'x'.repeat(IMPLICIT_OPEN_BUDGET_CHARS + 100) +
      ' the model printed </think> as plain text'
    expect(
      historyLeaksThinkTags([
        { role: 'assistant', content: [{ type: 'text', text: quoted }] },
      ]),
    ).toBe(false)
  })
})

describe('historyHasUnclosedOpen', () => {
  const assistant = (text: string) => ({
    role: 'assistant',
    content: [{ type: 'text', text }],
  })

  it('is false for a clean or properly paired last turn', () => {
    expect(historyHasUnclosedOpen([])).toBe(false)
    expect(historyHasUnclosedOpen([assistant('<think>x</think>answer')])).toBe(
      false,
    )
  })

  it('is true when the last assistant turn leaves an open unclosed', () => {
    expect(
      historyHasUnclosedOpen([assistant('answer<think>truncated thought')]),
    ).toBe(true)
  })

  it('is false when both tags are quoted in prose', () => {
    // Docs quoting the pair close after they open — not evidence of a leak.
    expect(
      historyHasUnclosedOpen([
        assistant('use <think> and </think> to mark reasoning'),
      ]),
    ).toBe(false)
  })

  it('heals: only the last assistant turn counts', () => {
    // A one-off quoted open arms exactly the next step; a clean reply after
    // it disarms, so later genuine traces are never held.
    expect(
      historyHasUnclosedOpen([
        assistant('answer<think>quoted once'),
        assistant('<think>x</think>clean answer'),
      ]),
    ).toBe(false)
  })

  it('ignores user messages and reasoning parts', () => {
    expect(
      historyHasUnclosedOpen([
        { role: 'user', content: [{ type: 'text', text: 'why <think>?' }] },
        {
          role: 'assistant',
          content: [{ type: 'reasoning', text: '<think>native' }],
        },
      ]),
    ).toBe(false)
  })
})
