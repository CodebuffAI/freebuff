const POLICY_EFFECTIVE_DATE = 'September 2, 2026'

export const FREEBUFF_POLICY_METADATA = {
  version: '2026-09-02',
  effectiveDate: POLICY_EFFECTIVE_DATE,
  lastUpdated: '09/02/2026',
  privacyPolicyLastUpdated: '09/24/2026',
} as const

export const FREEBUFF_PRIVACY_POLICY_URL = 'https://freebuff.com/privacy-policy'

export const FREEBUFF_AI_TRAINING_NOTICE = 'May use data for AI training'

export type FreebuffModelDataUse = 'service' | 'training'

/**
 * Canonical short-form public copy derived from the September 2 Privacy Policy.
 * Product surfaces should import these answers instead of restating data-use
 * promises. Static Markdown/MDX copies are protected by the drift test in
 * `freebuff-public-data-use-copy.test.ts`.
 */
export const FREEBUFF_PUBLIC_DATA_USE_COPY = {
  collectionQuestion: 'Does Freebuff collect my data?',
  collectionAnswer:
    'Freebuff collects prompts, messages, code, files, repository data, and agent traces when you use features that need them. Depending on the model or feature, AI model providers may also process that data. See the Privacy Policy for the uses and limits that apply.',
  trainingQuestion: 'Is my data used to train AI?',
  trainingAnswer:
    'Only when a model or feature says data may be used for AI training. Freebuff or the provider may then keep submissions to develop, train, test, evaluate, fine-tune, and improve AI models or products.',
  storageQuestion: 'How is my data used and stored?',
  storageAnswer: `We use prompts, messages, agent traces, code, files, and repository data to provide Freebuff. We may analyze prompts and messages to personalize ads. We do not give separately uploaded files or connected repositories to advertising providers. Restricted partners may evaluate connected Cloud repositories or code used with models labeled “${FREEBUFF_AI_TRAINING_NOTICE},” but cannot otherwise use, broadly share, or train on it. See the Privacy Policy for retention, eligibility, and advertising choices.`,
  compactTrainingSummary: `Models or features labeled “${FREEBUFF_AI_TRAINING_NOTICE}” may keep submissions to develop, train, test, evaluate, fine-tune, and improve AI models or products.`,
  compactPrivacySummary: `Prompts and messages may be analyzed to personalize ads. Separate uploads and connected repositories are not provided to advertising providers. Restricted partners may evaluate eligible codebases, but cannot otherwise use, broadly share, or train on them. Models or features labeled “${FREEBUFF_AI_TRAINING_NOTICE}” may separately use submissions for AI training.`,
  localExecutionSummary:
    'Freebuff edits files locally but sends relevant prompts, code, files, and repository context to its servers and model providers. See the Privacy Policy for details.',
  compactLocalExecutionSummary:
    'Edits run locally, but relevant prompts, code, files, and repository context are sent to Freebuff and model providers.',
} as const

export const FREEBUFF_DATA_USE_GENERATED_MARKDOWN_BLOCK = {
  start: '<!-- BEGIN GENERATED FREEBUFF DATA USE -->',
  end: '<!-- END GENERATED FREEBUFF DATA USE -->',
} as const

export const FREEBUFF_DATA_USE_GENERATED_MDX_BLOCK = {
  start: '{/* BEGIN GENERATED FREEBUFF DATA USE */}',
  end: '{/* END GENERATED FREEBUFF DATA USE */}',
} as const

export function renderFreebuffDataUseFaqMarkdown(): string {
  return `${FREEBUFF_DATA_USE_GENERATED_MARKDOWN_BLOCK.start}

**${FREEBUFF_PUBLIC_DATA_USE_COPY.trainingQuestion}** ${FREEBUFF_PUBLIC_DATA_USE_COPY.trainingAnswer}

**${FREEBUFF_PUBLIC_DATA_USE_COPY.storageQuestion}** ${FREEBUFF_PUBLIC_DATA_USE_COPY.storageAnswer}

See the [Privacy Policy](${FREEBUFF_PRIVACY_POLICY_URL}) for complete details.

${FREEBUFF_DATA_USE_GENERATED_MARKDOWN_BLOCK.end}`
}

export function renderFreebuffDataUseFaqMdx(): string {
  return `${FREEBUFF_DATA_USE_GENERATED_MDX_BLOCK.start}

## ${FREEBUFF_PUBLIC_DATA_USE_COPY.storageQuestion}

${FREEBUFF_PUBLIC_DATA_USE_COPY.storageAnswer}

## ${FREEBUFF_PUBLIC_DATA_USE_COPY.trainingQuestion}

${FREEBUFF_PUBLIC_DATA_USE_COPY.trainingAnswer}

See the [Privacy Policy](${FREEBUFF_PRIVACY_POLICY_URL}) for complete details.

${FREEBUFF_DATA_USE_GENERATED_MDX_BLOCK.end}`
}
