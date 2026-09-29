import { describe, expect, it } from 'bun:test'

import {
  historyLeaksThinkTags,
  IMPLICIT_OPEN_BUDGET_CHARS,
  MID_PROSE_THINK_BUDGET_CHARS,
  stripThinkScaffolding,
  ThinkTagStream,
} from '../think-tag-stream'

import type { ThinkStreamSegment } from '../think-tag-stream'

/** Feed the deltas one at a time, then flush — the shape a real stream has. */
function run(
  deltas: string[],
  options?: { implicitOpen?: boolean; stepCompleted?: boolean },
): ThinkStreamSegment[] {
  const stream = new ThinkTagStream(options)
  const out: ThinkStreamSegment[] = []
  for (const delta of deltas) out.push(...stream.push(delta))
  out.push(...stream.flush({ stepCompleted: options?.stepCompleted }))
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

  it('keeps an unclosed head block as reasoning when the step was cut off', () => {
    // Output limit, abort or interrupted stream: a thought that ran out of room.
    const out = run(['<think>truncated thou', 'ght'], { stepCompleted: false })
    expect(joined(out, 'reasoning')).toBe('truncated thought')
    expect(joined(out, 'text')).toBe('')
  })
})

// CodebuffAI/freebuff#1155: an explicit open tag used to send the rest of the
// step to the thinking box, so a model that wrote the tag as prose, or never
// closed it, showed the user an empty or cut-short reply.
describe('ThinkTagStream — explicit open that may not be a thought', () => {
  it('streams a proper head block live as reasoning, unchanged', () => {
    // The reasoning-lane shape (DeepSeek/GLM/MiMo in content). Reasoning must
    // reach the thinking box as it streams, not after the close.
    const stream = new ThinkTagStream()
    expect(stream.push('<think>Let me look')).toEqual([
      { type: 'reasoning', text: 'Let me look' },
    ])
    expect(stream.push(' at the file.</think>\n\nThe bug is')).toEqual([
      { type: 'reasoning', text: ' at the file.' },
      { type: 'text', text: '\n\nThe bug is' },
    ])
    expect(stream.push(' on line 4.')).toEqual([
      { type: 'text', text: ' on line 4.' },
    ])
    expect(stream.flush({ stepCompleted: true })).toEqual([])
  })

  it('treats leading whitespace as still the head of the step', () => {
    const out = run(['\n\n<think>plan</think>answer'], { stepCompleted: true })
    expect(joined(out, 'reasoning')).toBe('plan')
    expect(joined(out, 'text')).toBe('\n\nanswer')
  })

  it('re-emits an unclosed head block as text when the model ended the step', () => {
    const stream = new ThinkTagStream()
    // Streams as reasoning while the close could still come...
    expect(stream.push('<think>')).toEqual([])
    expect(stream.push('Here is the answer you asked for.')).toEqual([
      { type: 'reasoning', text: 'Here is the answer you asked for.' },
    ])
    // ...but the model stopped inside the block, so that was its reply.
    expect(stream.flush({ stepCompleted: true })).toEqual([
      { type: 'text', text: 'Here is the answer you asked for.' },
    ])
    // Idempotent: the safety-net flush does not emit it twice.
    expect(stream.flush({ stepCompleted: true })).toEqual([])
  })

  it('holds a <think> quoted mid-answer and releases it verbatim as text', () => {
    const out = run(
      [
        'Wrap the output in a ',
        '<think>',
        ' tag, then write the summary. Here is the rest of my answer.',
      ],
      { stepCompleted: true },
    )
    expect(joined(out, 'reasoning')).toBe('')
    expect(joined(out, 'text')).toBe(
      'Wrap the output in a <think> tag, then write the summary. Here is the rest of my answer.',
    )
  })

  it('releases a mid-answer <think> even on a cut-off step', () => {
    // Never a thought: nothing about a cut-off makes it one.
    const out = run(['Use <think> here.'], { stepCompleted: false })
    expect(joined(out, 'text')).toBe('Use <think> here.')
  })

  it('streams on as text once a mid-answer hold passes its budget', () => {
    const stream = new ThinkTagStream()
    expect(stream.push('Docs: <think>')).toEqual([
      { type: 'text', text: 'Docs: ' },
    ])
    const long = 'x'.repeat(MID_PROSE_THINK_BUDGET_CHARS)
    expect(stream.push(long)).toEqual([{ type: 'text', text: `<think>${long}` }])
    expect(stream.push(' more')).toEqual([{ type: 'text', text: ' more' }])
  })

  it('still routes a mid-answer block to reasoning when its close arrives', () => {
    const out = run(chars('before<think>thought</think>after'))
    expect(joined(out, 'text')).toBe('beforeafter')
    expect(joined(out, 'reasoning')).toBe('thought')
  })

  it('finds a close split across chunks, head or mid-answer', () => {
    const head = run(['<think>plan it</thi', 'nk>The answer.'], {
      stepCompleted: true,
    })
    expect(head).toEqual([
      { type: 'reasoning', text: 'plan it' },
      { type: 'text', text: 'The answer.' },
    ])

    const mid = run(['Answer. <think>aside</', 'think> Done.'], {
      stepCompleted: true,
    })
    expect(joined(mid, 'reasoning')).toBe('aside')
    expect(joined(mid, 'text')).toBe('Answer.  Done.')
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
      ['Ключевая зацепка: the bundle knows the type.', 'Do that.</think>Real answer.'],
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
    expect(stream.push('</think>tail')).toEqual([{ type: 'text', text: 'tail' }])
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
        { role: 'assistant', content: [{ type: 'reasoning', text: '</think>' }] },
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
    expect(stripThinkScaffolding('a\n\n<think>x</think>\n\nb')).toBe('a\n\n\n\nb')
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
