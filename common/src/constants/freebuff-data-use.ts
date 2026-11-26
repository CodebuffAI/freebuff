// AI training disclosure and sign-up agreement added to both documents.
const POLICY_EFFECTIVE_DATE = 'December 26, 2026'

export const FREEBUFF_POLICY_METADATA = {
  version: '2026-12-26',
  effectiveDate: POLICY_EFFECTIVE_DATE,
  lastUpdated: 'November 25, 2026',
  privacyPolicyLastUpdated: 'November 25, 2026',
} as const

export const FREEBUFF_PRIVACY_POLICY_URL = 'https://freebuff.com/privacy-policy'

export const FREEBUFF_AI_TRAINING_NOTICE = 'May use data for AI training'

export type FreebuffModelDataUse = 'service' | 'training'

/**
 * Canonical short-form public copy derived from the Privacy Policy.
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
    'Some models and features collect limited data for advertising, AI training, and sharing or selling with third parties.',
  storageQuestion: 'How is my data used and stored?',
  storageAnswer: `Freebuff uses your messages, agent traces, and files to run the service and respond to your requests. We may analyze this data, and how you use the app, to personalize ads and train ad models. We do not give separately uploaded files, project files, or connected repositories to advertising providers. Restricted partners may evaluate repositories you connect to Freebuff Cloud, but cannot otherwise use, broadly share, or train on them. See the Privacy Policy for details.`,
  localFilesQuestion: 'Does Freebuff read files outside my project?',
  localFilesAnswer:
    'No, with a few exceptions, such as files an agent reads in the conversation, files you share, and settings like your agent instructions and skills. See the Privacy Policy for details.',
  compactTrainingSummary:
    'Some models and features collect your data for AI training, and Freebuff may share or sell it to third parties.',
  compactPrivacySummary: `Messages, agent traces, files, and app usage may be analyzed to personalize ads and train ad models. Separately uploaded files, project files, and connected repositories are not provided to advertising providers. Restricted partners may evaluate connected Cloud repositories, but cannot otherwise use, broadly share, or train on them. Some models and features also collect your data for AI training, and Freebuff may share or sell it to third parties.`,
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

**${FREEBUFF_PUBLIC_DATA_USE_COPY.localFilesQuestion}** ${FREEBUFF_PUBLIC_DATA_USE_COPY.localFilesAnswer}

See the [Privacy Policy](${FREEBUFF_PRIVACY_POLICY_URL}) for complete details.

${FREEBUFF_DATA_USE_GENERATED_MARKDOWN_BLOCK.end}`
}

export function renderFreebuffDataUseFaqMdx(): string {
  return `${FREEBUFF_DATA_USE_GENERATED_MDX_BLOCK.start}

## ${FREEBUFF_PUBLIC_DATA_USE_COPY.storageQuestion}

${FREEBUFF_PUBLIC_DATA_USE_COPY.storageAnswer}

## ${FREEBUFF_PUBLIC_DATA_USE_COPY.trainingQuestion}

${FREEBUFF_PUBLIC_DATA_USE_COPY.trainingAnswer}

## ${FREEBUFF_PUBLIC_DATA_USE_COPY.localFilesQuestion}

${FREEBUFF_PUBLIC_DATA_USE_COPY.localFilesAnswer}

See the [Privacy Policy](${FREEBUFF_PRIVACY_POLICY_URL}) for complete details.

${FREEBUFF_DATA_USE_GENERATED_MDX_BLOCK.end}`
}
