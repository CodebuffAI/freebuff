import { TextAttributes } from '@opentui/core'
import React from 'react'

import { useTheme } from '../hooks/use-theme'
import { useProfileSurveyStore } from '../state/profile-survey-store'
import {
  currentQuestion,
  numberedOptions,
} from '../utils/profile-survey-machine'
import { BORDER_CHARS } from '../utils/ui-constants'

import type { ProfileSurveyState } from '../utils/profile-survey-machine'

/**
 * The CLI's in-session profile survey box (COD-779). Draws the machine's
 * state and nothing else: keys reach the machine through the chat keyboard
 * resolver (`keyboard-actions.ts`), never through a listener here, so the box
 * cannot take a keystroke the composer was owed. It sits beside the ad
 * surfaces, never in place of one, and reports nothing to the ad rail.
 */

const PROGRESS_FILLED = '■'
const PROGRESS_EMPTY = '□'

export function profileSurveyProgressBar(step: number, total: number): string {
  const done = Math.max(0, Math.min(step, total))
  return PROGRESS_FILLED.repeat(done) + PROGRESS_EMPTY.repeat(total - done)
}

export function profileSurveyHint(state: ProfileSurveyState): string {
  const question = currentQuestion(state)
  if (!question) return ''
  const numbered = numberedOptions(question)
  const top = numbered.filter((n) => n.key > 0).length
  const hasNa = numbered.some((n) => n.key === 0)
  const parts = [
    question.multi ? `1–${top} toggle` : `1–${top} pick`,
    ...(question.multi ? ['enter continue'] : []),
    ...(hasNa ? ["0 doesn't apply"] : []),
    ...(state.step > 0 ? ['← back'] : []),
    'esc not now (7 days)',
  ]
  return parts.join(' · ')
}

/** Options greedily packed into rows that fit `width` columns. */
export function packOptionLabels(labels: string[], width: number): string[] {
  const gap = '   '
  const rows: string[] = []
  let row = ''
  for (const label of labels) {
    if (!row) row = label
    else if (row.length + gap.length + label.length <= width) row += gap + label
    else {
      rows.push(row)
      row = label
    }
  }
  if (row) rows.push(row)
  return rows
}

export const ProfileSurveyBoxView = ({
  state,
  width,
}: {
  state: ProfileSurveyState
  width: number
}) => {
  const theme = useTheme()
  const question = currentQuestion(state)
  if (!question) return null
  const total = state.questions.length
  const innerWidth = Math.max(10, width - 4)
  const labels = numberedOptions(question).map(({ key, option }) => {
    const mark = question.multi
      ? state.selection.includes(option.id)
        ? '◉ '
        : '○ '
      : ''
    return `${key} ${mark}${option.label}`
  })
  const rows = packOptionLabels(labels, innerWidth)
  const reward =
    state.rewardFreebucks > 0
      ? `  +${state.rewardFreebucks} Freebucks for all ${total}`
      : ''

  return (
    <box
      style={{
        width,
        flexShrink: 0,
        borderStyle: 'single',
        borderColor: theme.muted,
        customBorderChars: BORDER_CHARS,
        paddingLeft: 1,
        paddingRight: 1,
        flexDirection: 'column',
      }}
    >
      <text style={{ fg: theme.muted, wrapMode: 'none' }}>
        {`quick question ${state.step + 1}/${total}  `}
        <span fg={theme.primary}>
          {profileSurveyProgressBar(state.step, total)}
        </span>
        {reward}
      </text>
      <text
        style={{ fg: theme.foreground, wrapMode: 'word' }}
        attributes={TextAttributes.BOLD}
      >
        {question.prompt}
      </text>
      {rows.map((row, i) => (
        <text key={i} style={{ fg: theme.foreground, wrapMode: 'none' }}>
          {row}
        </text>
      ))}
      <text style={{ fg: theme.muted, wrapMode: 'word' }}>
        {profileSurveyHint(state)}
      </text>
    </box>
  )
}

/** Connected: draws only while the chat has marked the box eligible and the
 *  machine is asking. */
export const ProfileSurveyBox = ({ width }: { width: number }) => {
  const survey = useProfileSurveyStore((s) => s.survey)
  const eligible = useProfileSurveyStore((s) => s.eligible)
  if (!eligible || !survey || survey.status !== 'asking') return null
  return <ProfileSurveyBoxView state={survey} width={width} />
}
