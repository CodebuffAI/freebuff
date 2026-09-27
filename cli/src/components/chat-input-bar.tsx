import {
  isShallowScanRoot,
  SHALLOW_SCAN_MAX_DEPTH,
} from '@codebuff/common/project-file-tree'
import React from 'react'

import { AgentModeToggle } from './agent-mode-toggle'
import { Button } from './button'
import { ClickableTitleBox } from './clickable-title-box'
import { MultipleChoiceForm } from './ask-user'
import { FeedbackContainer } from './feedback-container'
import { InputModeBanner } from './input-mode-banner'
import { MultilineInput, type MultilineInputHandle } from './multiline-input'
import { OutOfCreditsBanner } from './out-of-credits-banner'
import { PublishContainer } from './publish-container'
import { PartnerAdLine } from './partner-ad-line'
import { SuggestionMenu, type SuggestionItem } from './suggestion-menu'
import { CLI_PARTNER_PLACEMENT_IDS } from '../ads/partner-ads'
import { useAskUserBridge } from '../hooks/use-ask-user-bridge'
import { useEvent } from '../hooks/use-event'
import { tryGetProjectRoot } from '../project-files'
import { useChatStore } from '../state/chat-store'
import { shouldInterceptChatInputKey } from '../utils/chat-input-key-intercept'
import { getInputModeConfig } from '../utils/input-modes'
import { BORDER_CHARS } from '../utils/ui-constants'

import type { useTheme } from '../hooks/use-theme'
import type { InputValue } from '../types/store'
import type { AgentMode } from '../utils/constants'
import type { MouseEvent } from '@opentui/core'

type Theme = ReturnType<typeof useTheme>

interface ChatInputBarProps {
  // Input state
  inputValue: string
  cursorPosition: number
  setInputValue: (
    value: InputValue | ((prev: InputValue) => InputValue),
  ) => void
  inputFocused: boolean
  inputRef: React.MutableRefObject<MultilineInputHandle | null>
  inputPlaceholder: string
  lastEditDueToNav: boolean

  // Agent mode
  agentMode: AgentMode
  toggleAgentMode: () => void
  setAgentMode: (mode: AgentMode) => void

  // Suggestion menus
  hasSlashSuggestions: boolean
  hasMentionSuggestions: boolean
  hasSuggestionMenu: boolean
  slashSuggestionItems: SuggestionItem[]
  agentSuggestionItems: SuggestionItem[]
  fileSuggestionItems: SuggestionItem[]
  slashSelectedIndex: number
  agentSelectedIndex: number
  onSlashItemClick?: (index: number) => void
  onMentionItemClick?: (index: number) => void
  /**
   * Whether the PARTNER row under `/review` may be drawn — the same gate the
   * rotating card above the input reads (ads on, no BYOK connection, free
   * mode or no subscription). The row itself draws nothing unless the deal is
   * live and the slot filled.
   */
  showSlashPartnerAd?: boolean

  // Layout
  theme: Theme
  terminalHeight: number
  separatorWidth: number
  shouldCenterInputVertically: boolean
  inputBoxTitle: string | undefined
  onQueuePreviewClick?: () => void
  isCompactHeight: boolean
  isNarrowWidth: boolean

  // Feedback mode
  feedbackMode: boolean
  handleExitFeedback: () => void

  // Publish mode
  publishMode: boolean
  handleExitPublish: () => void
  handlePublish: (agentIds: string[]) => Promise<void>

  // Handlers
  handleSubmit: () => Promise<void>
  onPaste: (fallbackText?: string) => void
  onInterruptStream: () => void
}

export const ChatInputBar = ({
  inputValue,
  cursorPosition,
  setInputValue,
  inputFocused,
  inputRef,
  inputPlaceholder,
  lastEditDueToNav,
  agentMode,
  toggleAgentMode,
  setAgentMode,
  hasSlashSuggestions,
  hasMentionSuggestions,
  hasSuggestionMenu,
  slashSuggestionItems,
  agentSuggestionItems,
  fileSuggestionItems,
  slashSelectedIndex,
  agentSelectedIndex,
  onSlashItemClick,
  onMentionItemClick,
  showSlashPartnerAd = false,
  theme,
  terminalHeight,
  separatorWidth,
  shouldCenterInputVertically,
  inputBoxTitle,
  onQueuePreviewClick,
  isCompactHeight,
  isNarrowWidth,
  feedbackMode,
  handleExitFeedback,
  publishMode,
  handleExitPublish,
  handlePublish,
  handleSubmit,
  onPaste,
  onInterruptStream,
}: ChatInputBarProps) => {
  const inputMode = useChatStore((state) => state.inputMode)
  const pendingSkillName = useChatStore((state) => state.pendingSkillName)

  const baseModeConfig = getInputModeConfig(inputMode)
  // Skill mode names the pending skill in the banner so the user can see
  // what their text will be attached to. Skill names run up to 64 chars;
  // keep the banner narrow enough to leave room for typing.
  const skillLabel =
    inputMode === 'skill' && pendingSkillName
      ? pendingSkillName.length > 24
        ? `${pendingSkillName.slice(0, 23)}…`
        : pendingSkillName
      : null
  const modeConfig = skillLabel
    ? {
        ...baseModeConfig,
        label: skillLabel,
        widthAdjustment: skillLabel.length + 3,
      }
    : baseModeConfig
  const askUserState = useChatStore((state) => state.askUserState)
  const hasAnyPreview = hasSuggestionMenu

  /**
   * The partner row under `/review`, as the menu's `afterItem`.
   *
   * Built once and handed to both layouts, so the compact and bordered menus
   * cannot disagree about whether the slot exists. `SuggestionMenu` draws it
   * only while `review` is in its visible window, which is what keeps the
   * request to the one time the command is actually on screen.
   *
   * The width is the menu's own (`terminalWidth - 8`, expressed against
   * `separatorWidth`), so the fill spans exactly the rows above it.
   */
  const slashPartnerAd = showSlashPartnerAd
    ? {
        id: 'review',
        node: (
          <PartnerAdLine
            key="partner-review"
            placementId={CLI_PARTNER_PLACEMENT_IDS.slashReview}
            width={Math.max(10, separatorWidth - 6)}
          />
        ),
      }
    : undefined

  // In the home directory (or an ancestor) the file tree is only scanned a few
  // levels deep, so tell the user why deeper files don't show up.
  const mentionMenuFooter = isShallowScanRoot(tryGetProjectRoot())
    ? `Files shown up to ${SHALLOW_SCAN_MAX_DEPTH} levels deep — open a project folder for full results`
    : undefined

  // Increase menu size on larger screen heights
  const normalModeMaxVisible = terminalHeight > 35 ? 15 : 10
  const { submitAnswers, skip } = useAskUserBridge()
  const [askUserTitle] = React.useState(' Some questions for you ')

  // Shared key intercept handler for suggestion menu navigation and history navigation
  const handleKeyIntercept = useEvent(
    (key: {
      name?: string
      sequence?: string
      shift?: boolean
      ctrl?: boolean
      meta?: boolean
      option?: boolean
    }) => {
      const draft = useChatStore.getState()
      return shouldInterceptChatInputKey(key, {
        inputMode: draft.inputMode,
        hasSlashSuggestions,
        hasMentionSuggestions,
        lastEditDueToNav: draft.lastEditDueToNav,
        cursorPosition: draft.cursorPosition,
        inputLength: draft.inputValue.length,
      })
    },
  )

  if (feedbackMode) {
    return (
      <FeedbackContainer
        inputRef={inputRef}
        onExitFeedback={handleExitFeedback}
        width={separatorWidth}
      />
    )
  }

  if (publishMode) {
    return (
      <PublishContainer
        inputRef={inputRef}
        onExitPublish={handleExitPublish}
        onPublish={handlePublish}
        width={separatorWidth}
      />
    )
  }

  // Out of credits mode: replace entire input with out-of-credits banner
  if (inputMode === 'outOfCredits') {
    return <OutOfCreditsBanner />
  }

  // Subscription limit mode: show only the limit banner (no input box)
  if (inputMode === 'subscriptionLimit') {
    return <InputModeBanner />
  }

  const handleFormSubmit = (
    answers: { question: string; answer: string }[],
  ) => {
    if (!askUserState) return

    // Convert accordion-style answers to the format expected by submitAnswers
    const formattedAnswers = askUserState.questions.map((q, idx) => {
      const answerObj = answers[idx]
      if (!answerObj || answerObj.answer === 'Skipped') {
        return { questionIndex: idx }
      }

      // For multi-select questions, always use selectedOptions array format
      if (q.multiSelect) {
        // Split by ', ' to get individual options (even if just one)
        const selectedOptions = answerObj.answer.split(', ').filter(Boolean)

        // Check if all selected options match known options (not "other" text)
        const allMatchKnownOptions = selectedOptions.every((selected) =>
          q.options.some((opt) => {
            const label = typeof opt === 'string' ? opt : opt.label
            return label === selected
          }),
        )

        if (allMatchKnownOptions && selectedOptions.length > 0) {
          return {
            questionIndex: idx,
            selectedOptions,
          }
        }

        // Otherwise it's an "other" text answer for multi-select
        return {
          questionIndex: idx,
          otherText: answerObj.answer,
        }
      }

      // For single-select questions, check if the answer matches one of the options
      const matchingOptionIndex = q.options.findIndex((opt) => {
        const label = typeof opt === 'string' ? opt : opt.label
        return label === answerObj.answer
      })

      if (matchingOptionIndex >= 0) {
        return {
          questionIndex: idx,
          selectedOption: answerObj.answer,
        }
      }

      // Otherwise it's an "other" text answer
      return {
        questionIndex: idx,
        otherText: answerObj.answer,
      }
    })

    submitAnswers(formattedAnswers)
  }

  const handleFormSkip = () => {
    if (!askUserState) return
    skip()
    onInterruptStream()
  }

  const effectivePlaceholder =
    inputMode === 'default' ? inputPlaceholder : modeConfig.placeholder
  const borderColor = theme[modeConfig.color]

  if (askUserState) {
    return (
      <box
        title={askUserTitle}
        titleAlignment="center"
        style={{
          width: '100%',
          borderStyle: 'single',
          borderColor: theme.primary,
          customBorderChars: BORDER_CHARS,
        }}
      >
        <MultipleChoiceForm
          questions={askUserState.questions}
          onSubmit={handleFormSubmit}
          onSkip={handleFormSkip}
        />
      </box>
    )
  }

  // Compact mode: no border, minimal chrome, supports menus and multiline
  if (isCompactHeight) {
    const compactMaxHeight = Math.floor(terminalHeight / 2)
    return (
      <>
        {hasSlashSuggestions ? (
          <SuggestionMenu
            items={slashSuggestionItems}
            selectedIndex={slashSelectedIndex}
            maxVisible={5}
            prefix="/"
            onItemClick={onSlashItemClick}
            afterItem={slashPartnerAd}
          />
        ) : null}
        {hasMentionSuggestions ? (
          <SuggestionMenu
            items={[...agentSuggestionItems, ...fileSuggestionItems]}
            selectedIndex={agentSelectedIndex}
            maxVisible={5}
            prefix="@"
            onItemClick={onMentionItemClick}
            footer={mentionMenuFooter}
          />
        ) : null}
        {inputBoxTitle && onQueuePreviewClick && (
          <Button
            onClick={(event) => {
              if ((event as MouseEvent | undefined)?.button === 0) {
                onQueuePreviewClick()
              }
            }}
            style={{
              width: '100%',
              height: 1,
              paddingLeft: 1,
              paddingRight: 1,
              backgroundColor: theme.surface,
              overflow: 'hidden',
            }}
          >
            <text style={{ fg: theme.muted, wrapMode: 'none' }}>
              {inputBoxTitle.trim()}
            </text>
          </Button>
        )}
        <box
          style={{
            flexDirection: 'row',
            alignItems: 'flex-start',
            width: '100%',
            paddingLeft: 1,
            paddingRight: 1,
            backgroundColor: theme.surface,
          }}
        >
          {modeConfig.label && (
            <box style={{ flexShrink: 0, paddingRight: 1 }}>
              <text>
                <span
                  bg={theme.info}
                  fg={theme.background}
                >{` ${modeConfig.label} `}</span>
              </text>
            </box>
          )}
          {modeConfig.icon && (
            <box
              style={{
                flexShrink: 0,
                paddingRight: 1,
              }}
            >
              <text style={{ fg: theme[modeConfig.color] }}>
                {modeConfig.icon}
              </text>
            </box>
          )}
          {/* In default modes the compact box has no border or label, so it can
              read as a passive status line. A shell-style prompt glyph signals
              that it's a focusable input — costs no extra height. */}
          {!modeConfig.label && !modeConfig.icon && (
            <box style={{ flexShrink: 0 }}>
              <text style={{ fg: theme.primary }}>❯</text>
            </box>
          )}
          <MultilineInput
            value={inputValue}
            onChange={setInputValue}
            onSubmit={handleSubmit}
            onPaste={onPaste}
            onKeyIntercept={handleKeyIntercept}
            placeholder={effectivePlaceholder}
            focused={inputFocused && !feedbackMode}
            maxHeight={compactMaxHeight}
            ref={inputRef}
            cursorPosition={cursorPosition}
          />
        </box>
        <InputModeBanner />
      </>
    )
  }

  return (
    <>
      <ClickableTitleBox
        title={inputBoxTitle}
        titleAlignment="center"
        onTitleClick={onQueuePreviewClick}
        style={{
          width: '100%',
          borderStyle: 'single',
          borderColor,
          customBorderChars: BORDER_CHARS,
          paddingLeft: 1,
          paddingRight: 1,
          paddingTop: 0,
          paddingBottom: 0,
          flexDirection: 'column',
          gap: hasAnyPreview ? 1 : 0,
        }}
      >
        {hasSlashSuggestions ? (
          <SuggestionMenu
            items={slashSuggestionItems}
            selectedIndex={slashSelectedIndex}
            maxVisible={normalModeMaxVisible}
            prefix="/"
            onItemClick={onSlashItemClick}
            afterItem={slashPartnerAd}
          />
        ) : null}
        {hasMentionSuggestions ? (
          <SuggestionMenu
            items={[...agentSuggestionItems, ...fileSuggestionItems]}
            selectedIndex={agentSelectedIndex}
            maxVisible={normalModeMaxVisible}
            prefix="@"
            onItemClick={onMentionItemClick}
            footer={mentionMenuFooter}
          />
        ) : null}
        <box
          style={{
            flexDirection: 'column',
            justifyContent: shouldCenterInputVertically
              ? 'center'
              : 'flex-start',
            minHeight: shouldCenterInputVertically ? 3 : undefined,
            gap: 0,
          }}
        >
          <box
            style={{
              flexDirection: 'row',
              alignItems: shouldCenterInputVertically ? 'center' : 'flex-start',
              width: '100%',
            }}
          >
            {modeConfig.label && (
              <box style={{ flexShrink: 0, paddingRight: 1 }}>
                <text>
                  <span
                    bg={theme.info}
                    fg={theme.background}
                  >{` ${modeConfig.label} `}</span>
                </text>
              </box>
            )}
            {modeConfig.icon && (
              <box
                style={{
                  flexShrink: 0,
                  paddingRight: 1,
                }}
              >
                <text style={{ fg: theme[modeConfig.color] }}>
                  {modeConfig.icon}
                </text>
              </box>
            )}
            <box style={{ flexGrow: 1, minWidth: 0 }}>
              <MultilineInput
                value={inputValue}
                onChange={setInputValue}
                onSubmit={handleSubmit}
                onPaste={onPaste}
                onKeyIntercept={handleKeyIntercept}
                placeholder={effectivePlaceholder}
                focused={inputFocused && !feedbackMode}
                maxHeight={Math.floor(terminalHeight / 2)}
                ref={inputRef}
                cursorPosition={cursorPosition}
              />
            </box>
            {modeConfig.showAgentModeToggle && !isNarrowWidth && (
              <box
                style={{
                  flexShrink: 0,
                  paddingLeft: 2,
                }}
              >
                <AgentModeToggle
                  mode={agentMode}
                  onToggle={toggleAgentMode}
                  onSelectMode={setAgentMode}
                />
              </box>
            )}
          </box>
        </box>
      </ClickableTitleBox>
      <InputModeBanner />
    </>
  )
}
