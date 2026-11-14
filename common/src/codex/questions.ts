import { z } from 'zod/v4'

/** Shared native question shape; both Desktop and Cloud render the same card. */
export interface CodexQuestion {
  question: string
  header?: string
  options: { label: string; description?: string }[]
  allowFreeText?: boolean
  isSecret?: boolean
}

/** The host question service, independent of Codex's two native delivery formats. */
export interface CodexQuestionHost {
  request: (
    questions: CodexQuestion[],
    signal: AbortSignal,
  ) => Promise<string[][] | null>
  // Async tool answers are new user input, even if the original turn has already finished.
  notify: (questions: CodexQuestion[], itemId: string) => void
}

/** Native async tools already returned; their answers arrive as new input on the same session. */
export function codexQuestionAnswerPrompt(
  questions: Pick<CodexQuestion, 'question'>[],
  answers: string[][],
): string {
  return [
    'I answered your questions:',
    ...questions.map((q, index) =>
      `${q.question}\n${answers[index]?.join('\n') || '(No answer provided)'}`,
    ),
    'Continue using these answers.',
  ].join('\n\n')
}

const option = z.object({ label: z.string(), description: z.string() })
const requestSchema = z.object({
  questions: z
    .array(
      z.object({
        id: z.string().min(1),
        header: z.string(),
        question: z.string().min(1),
        options: z.array(option).nullish(),
        isOther: z.boolean().optional(),
        isSecret: z.boolean().optional(),
      }),
    )
    .min(1),
})
const asyncQuestionsSchema = z
  .array(
    z.object({
      title: z.string().min(1),
      // Codex serializes omitted choices as null for free-text async questions.
      options: z.array(z.string()).nullish(),
    }),
  )
  .min(1)

/** Owns only native RPC lifetimes. Async message cards belong to the thread, not this connection. */
export class CodexQuestions {
  private readonly pending = new Map<string | number, AbortController>()
  private readonly messages = new Set<string>()
  private closed = false

  constructor(private readonly host: CodexQuestionHost) {}

  async request(id: string | number, params: unknown): Promise<unknown> {
    if (this.closed) return undefined
    const { questions } = requestSchema.parse(params)
    if (new Set(questions.map((q) => q.id)).size !== questions.length)
      throw new Error('Codex question IDs must be unique.')
    if (this.pending.has(id))
      throw new Error('Codex question request is already pending.')
    const controller = new AbortController()
    this.pending.set(id, controller)
    const cancelled = new Promise<null>((resolve) => {
      controller.signal.addEventListener('abort', () => resolve(null), {
        once: true,
      })
    })
    try {
      const answers = await Promise.race([
        this.host.request(
          questions.map((q) => ({
            question: q.question,
            header: q.header,
            options: q.options ?? [],
            allowFreeText: q.isOther !== false || !q.options?.length,
            ...(q.isSecret ? { isSecret: true } : {}),
          })),
          controller.signal,
        ),
        cancelled,
      ])
      // Codex already cleared this request (or the transport stopped). Never send a stale reply.
      if (controller.signal.aborted) return undefined
      return {
        answers:
          answers === null
            ? {}
            : Object.fromEntries(
                questions.map((q, index) => [
                  q.id,
                  { answers: answers[index] ?? [] },
                ]),
              ),
      }
    } finally {
      this.pending.delete(id)
    }
  }

  resolve(id: unknown): void {
    if (typeof id === 'string' || typeof id === 'number')
      this.pending.get(id)?.abort()
  }

  close(): void {
    this.closed = true
    this.cancelRequests()
  }

  /** A host may run several native turns while async questions remain outstanding. */
  cancelRequests(): void {
    for (const controller of this.pending.values()) controller.abort()
  }

  /** Returns true when the structured message replaces the ordinary prose rendering. */
  notification(
    method: string,
    params: Record<string, unknown> | undefined,
  ): boolean {
    if (this.closed) return false
    if (method === 'serverRequest/resolved') this.resolve(params?.requestId)
    if (method === 'item/agentMessage/delta')
      return this.messages.has(String(params?.itemId))
    if (method !== 'item/started' && method !== 'item/completed') return false
    const item = params?.item as Record<string, unknown> | undefined
    if (
      item?.type !== 'agentMessage' ||
      item.delivery !== 'async' ||
      typeof item.id !== 'string'
    )
      return false
    const parsed = asyncQuestionsSchema.safeParse(item.questions)
    if (!parsed.success) return false // Keep ordinary async prose, or an unknown future shape, visible.
    if (!this.messages.has(item.id)) {
      this.messages.add(item.id)
      this.host.notify(
        parsed.data.map((q) => ({
          question: q.title,
          options: (q.options ?? []).map((label) => ({ label })),
        })),
        item.id,
      )
    }
    return true
  }
}
