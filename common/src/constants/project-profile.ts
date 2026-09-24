export const PROJECT_PROFILE_TOOL_NAME = 'report_project_profile'

export const PROJECT_APP_KINDS = [
  'Web app',
  'Mobile app',
  'Desktop app',
  'Backend / API',
  'CLI tool',
  'Library / package',
  'Game',
  'Data / ML',
  'Other',
] as const

export type ProjectAppKind = (typeof PROJECT_APP_KINDS)[number]

export const PROJECT_PROFILE_STATUSES = [
  'unchanged',
  'updated',
  'not_enough_context',
] as const

export const PROJECT_PROFILE_REPORT_INTERVAL_MS = 24 * 60 * 60 * 1000

export const PROJECT_PROFILE_MAX_TECHNOLOGIES = 60

export const PROJECT_PROFILE_MAX_VALUE_LENGTH = 80

export type ProjectProfile = {
  appKinds: string[]
  technologies: string[]
}

export type ProjectProfileReport =
  | { changed: false }
  | { changed: true; appKinds: ProjectAppKind[]; technologies: string[] }

function formatList(values: string[]): string {
  return values.length > 0 ? values.join(', ') : '(none)'
}

export function buildProjectProfileRequest(
  current: ProjectProfile | null,
): string {
  const currentProfile = current
    ? [
        'Current profile of this project:',
        `  app_kinds: ${formatList(current.appKinds)}`,
        `  technologies: ${formatList(current.technologies)}`,
      ].join('\n')
    : 'This project has no profile yet.'
  return [
    '<system_instructions>',
    `This is an internal request, not from the user. Call ${PROJECT_PROFILE_TOOL_NAME} once and do nothing else.`,
    '',
    currentProfile,
    '',
    'Answer only from what you have actually seen of this project in this conversation: files you read, commands you ran, output you saw. Do not guess.',
    'If you have not seen enough of the project to describe it, set status to "not_enough_context".',
    'If the current profile is still correct, set status to "unchanged".',
    'Otherwise set status to "updated" and send the complete new profile. It replaces the old one, so keep values from the current profile unless you know they are wrong.',
    `app_kinds lists every kind of app in the project, one or more of: ${PROJECT_APP_KINDS.join(', ')}.`,
    'technologies lists the programming languages, frameworks, libraries, databases, platforms and tools the project uses, including Git and any CI service.',
    'Use the names from the Stack Overflow Developer Survey (for example "TypeScript", "Next.js", "PostgreSQL", "Docker"). For anything not in the survey, use its official name.',
    '</system_instructions>',
  ].join('\n')
}
