import { z } from 'zod/v4'

/** Older servers ignore this header; older clients never receive a blocking tool. */
export const CLOUD_QUESTIONS_HEADER = 'x-freebuff-cloud-questions'

export const cloudQuestionsSchema = z.object({
  questions: z
    .array(
      z.object({
        question: z.string().trim().min(1).max(10_000),
        header: z.string().max(24).optional().catch(undefined),
        options: z
          .array(
            z.object({
              label: z.string().trim().min(1).max(500),
              description: z.string().max(2000).optional().catch(undefined),
            }),
          )
          .max(6)
          .optional()
          .catch(undefined),
        allowFreeText: z.boolean().optional(),
        isSecret: z.boolean().optional(),
        multiSelect: z.boolean().optional().catch(undefined),
      }),
    )
    .min(1)
    .max(20),
})

export type CloudQuestion = Omit<
  z.infer<typeof cloudQuestionsSchema>['questions'][number],
  'options'
> & {
  options: { label: string; description?: string }[]
}
export type CloudQuestionRequest = {
  id: string
  questions: CloudQuestion[]
  /** Its turn ended while the card waited (DEVICE_QUESTION_WAIT_MS): an answer
   *  now goes out as the user's next message. */
  deferred?: boolean
}

/**
 * How long a turn on the user's computer waits on an unanswered question card
 * before it ends quietly (completed, no error) and frees its runner slot. The
 * card stays open on the chat's latest run and its answer becomes the next
 * message; the client looks for such cards only on runs at least this long.
 */
export const DEVICE_QUESTION_WAIT_MS = 15 * 60_000

export const cloudQuestionAnswerSchema = z.discriminatedUnion('skipped', [
  z.object({ skipped: z.literal(true) }),
  z.object({
    skipped: z.literal(false),
    answers: z
      .array(z.array(z.string().trim().min(1).max(10_000)).max(7))
      .min(1)
      .max(20),
  }),
])
export type CloudQuestionAnswer = z.infer<typeof cloudQuestionAnswerSchema>
export type CloudQuestionResult = ReturnType<typeof cloudQuestionResult>

export function cloudQuestionResult(
  questions: CloudQuestion[],
  answer: CloudQuestionAnswer,
) {
  return answer.skipped
    ? {
        skipped: true,
        note: 'The user skipped these questions. Continue without assuming an answer.',
      }
    : {
        answers: questions.map((question, index) => ({
          question: question.question,
          answers: answer.answers[index] ?? [],
        })),
      }
}
