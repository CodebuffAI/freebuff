/**
 * Starters: the three things a new account is offered under its first
 * composer, chosen by its onboarding role (`freebuff-onboarding.ts`).
 *
 * A click sends the starter's short `message`, which is all the transcript
 * shows, with its `id` on the run. The server holds each id's playbook
 * (`web/src/server/desktop-cloud/starter-playbooks.ts`): it has the agent ask
 * one short question, offer the app the answer names, and then do the work.
 * The playbook stays on the chat, so the turn after "I connected Notion. Go
 * ahead." still has it.
 *
 * Ids are stored on runs (`freebuff_cloud_run.request`), so they are
 * append-only, as onboarding ids are: retire a starter by removing it from
 * its role, never by renaming it.
 */

import type { WorkspaceMode } from '../desktop-cloud/workspace-mode'

export const FREEBUFF_STARTER_IDS = [
  // Students
  'study-guide',
  'quiz-me',
  'plan-deadlines',
  // Creatives
  'pitch-deck',
  'plan-posts',
  'moodboard',
  // Operations, and founders
  'prep-meetings',
  'triage-inbox',
  'dropped-balls',
  // Hobbyists
  'build-game',
  'make-website',
  'hobby-app',
  // Web designers
  'landing-page',
  'redesign-site',
  'design-to-site',
  // Developers
  'resume-work',
  'map-codebase',
  'fix-top-issue',
  // Developers starting from scratch (added 2026-11-26)
  'new-app',
] as const

export type FreebuffStarterId = (typeof FREEBUFF_STARTER_IDS)[number]

export type FreebuffStarter = {
  id: FreebuffStarterId
  /** The pill. */
  label: string
  /** What the click sends, and what the transcript shows. */
  message: string
  /** The workspace the chat runs in: Chat for people who are not developers. */
  mode: WorkspaceMode
  /** Only in a chat that already has a project (a developer's repository). */
  needsProject?: true
}

export const FREEBUFF_STARTERS: Readonly<Record<FreebuffStarterId, FreebuffStarter>> = {
  'study-guide': { id: 'study-guide', label: 'Make a study guide', message: 'Make me a study guide', mode: 'chat' },
  'quiz-me': { id: 'quiz-me', label: 'Quiz me', message: 'Quiz me on what I’m studying', mode: 'chat' },
  'plan-deadlines': { id: 'plan-deadlines', label: 'Plan my deadlines', message: 'Plan my deadlines', mode: 'chat' },
  'pitch-deck': { id: 'pitch-deck', label: 'Brief to pitch deck', message: 'Turn my brief into a pitch deck', mode: 'chat' },
  'plan-posts': { id: 'plan-posts', label: 'Plan my next 9 posts', message: 'Plan my next 9 posts', mode: 'chat' },
  moodboard: { id: 'moodboard', label: 'Make a moodboard', message: 'Make me a moodboard', mode: 'chat' },
  'prep-meetings': { id: 'prep-meetings', label: 'Prep my meetings', message: 'Prep me for my meetings', mode: 'chat' },
  'triage-inbox': { id: 'triage-inbox', label: 'Triage my inbox', message: 'Triage my inbox', mode: 'chat' },
  'dropped-balls': { id: 'dropped-balls', label: 'What am I dropping?', message: 'What am I dropping?', mode: 'chat' },
  'build-game': { id: 'build-game', label: 'Build a game', message: 'Build me a game', mode: 'code' },
  'make-website': { id: 'make-website', label: 'Make my website', message: 'Make me a website', mode: 'code' },
  'hobby-app': { id: 'hobby-app', label: 'An app for my hobby', message: 'Build an app for my hobby', mode: 'code' },
  'landing-page': { id: 'landing-page', label: 'Design a landing page', message: 'Design a landing page', mode: 'code' },
  'redesign-site': { id: 'redesign-site', label: 'Redesign my site', message: 'Redesign my website', mode: 'code' },
  'design-to-site': { id: 'design-to-site', label: 'Turn a design into a site', message: 'Turn my design into a live site', mode: 'code' },
  'resume-work': { id: 'resume-work', label: 'Pick up where I left off', message: 'Pick up where I left off', mode: 'code', needsProject: true },
  'map-codebase': { id: 'map-codebase', label: 'Map this codebase', message: 'Map this codebase for me', mode: 'code', needsProject: true },
  'fix-top-issue': { id: 'fix-top-issue', label: 'Fix my top issue', message: 'Fix my top issue', mode: 'code', needsProject: true },
  'new-app': { id: 'new-app', label: 'Build an app', message: 'Build me an app', mode: 'code' },
}

/** Each onboarding role's starters, by its option id. A role not listed gets none. */
export const FREEBUFF_ROLE_STARTERS: Readonly<Record<string, readonly FreebuffStarterId[]>> = {
  student: ['study-guide', 'quiz-me', 'plan-deadlines'],
  creative: ['pitch-deck', 'plan-posts', 'moodboard'],
  operations: ['prep-meetings', 'triage-inbox', 'dropped-balls'],
  founder: ['prep-meetings', 'triage-inbox', 'dropped-balls'],
  hobbyist: ['build-game', 'make-website', 'hobby-app'],
  web_designer: ['landing-page', 'redesign-site', 'design-to-site'],
  // The first three on a codebase; the rest on a new or empty project, where there is none.
  professional_dev: ['resume-work', 'map-codebase', 'fix-top-issue', 'new-app', 'make-website', 'build-game'],
}

export function starterForId(id: string | null | undefined): FreebuffStarter | null {
  return id && Object.hasOwn(FREEBUFF_STARTERS, id) ? FREEBUFF_STARTERS[id as FreebuffStarterId] : null
}

export function startersForRole(role: string | null | undefined): FreebuffStarter[] {
  return role && Object.hasOwn(FREEBUFF_ROLE_STARTERS, role)
    ? FREEBUFF_ROLE_STARTERS[role].map((id) => FREEBUFF_STARTERS[id])
    : []
}

/** The workspace a role's first landing opens in: Chat unless its starters are Code mode's. */
export function roleStartingMode(role: string | null | undefined): WorkspaceMode | null {
  const starters = startersForRole(role)
  return starters.length ? starters[0].mode : null
}
