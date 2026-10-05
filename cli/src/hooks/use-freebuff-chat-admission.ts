import { useEffect, useRef } from 'react'
import { formatFreebuffHardBlockedPrivacySignals } from '@codebuff/common/util/freebuff-privacy'

import {
  resolveFreebuffModelPickForSession,
  refreshFreebuffSessionMetadata,
  startFreebuffSession,
} from './use-freebuff-session'
import {
  useFreebuffChatStore,
  type ChatAdmission,
} from '../state/freebuff-chat-store'
import { getFreebuffModelDirectory } from '../state/freebuff-catalog-store'
import { useFreebuffSessionStore } from '../state/freebuff-session-store'
import {
  freebucksOf,
  freebucksRowIntent,
  freebucksPriceLabel,
  formatFreebucks,
} from '../utils/freebucks'
import type { FreebuffSessionResponse } from '../types/freebuff-session'

export function freebuffAdmissionNotice(
  session: FreebuffSessionResponse | null,
): string | null {
  if (!session) return null
  switch (session.status) {
    case 'banned':
      return 'This account is suspended. If this is a mistake, contact support@codebuff.com.'
    case 'country_blocked':
      return session.countryBlockReason === 'anonymous_network'
        ? `Freebuff detected ${formatFreebuffHardBlockedPrivacySignals(session.ipPrivacySignals)} traffic. Disable VPN, proxy or Tor traffic and try again.`
        : session.countryCode === 'UNKNOWN'
          ? 'Freebuff could not verify your location. Check your VPN or proxy settings and try again.'
          : `Freebuff is unavailable in ${session.countryCode}. Use /byok to use your own API key.`
    case 'rate_limited':
      return session.freebucksShortfall
        ? `Not enough Freebucks: ${formatFreebucks(session.freebucksShortfall.balance)} available. See https://freebuff.com/plans or use /model.`
        : 'Session limit reached. See https://freebuff.com/plans or choose another model with /model.'
    case 'spend_limited':
      return session.message
    case 'ip_capped':
      return 'Too many Freebuff sessions on this network. Try again after another session finishes.'
    case 'superseded':
      return 'This session was taken over elsewhere. Send again to start a new session.'
    default:
      return null
  }
}

/** Identity-check every continuation: a cancelled send must never restart itself. */
export async function beginFreebuffChatAdmission(admission: ChatAdmission) {
  if (useFreebuffChatStore.getState().admission !== admission) return
  if (admission.phase === 'confirm') {
    const intentFor = (session: FreebuffSessionResponse | null | undefined) =>
      freebucksRowIntent(
        freebucksOf(session),
        admission.model,
        session?.status === 'active' ? session.model : undefined,
      )
    // A price/balance change must update the question before its answer can
    // authorize spending. This re-check is the only guard: the server takes
    // no wallet ceiling, so a stale answer would spend unasked.
    if (
      JSON.stringify(intentFor(admission.previousSession)) !==
      JSON.stringify(intentFor(useFreebuffSessionStore.getState().session))
    ) {
      useFreebuffChatStore.setState({
        admission: { phase: 'requested', model: admission.model },
      })
      return
    }
  }
  const starting: ChatAdmission = {
    ...admission,
    phase: 'starting',
    message: undefined,
    previousSession: useFreebuffSessionStore.getState().session,
  }
  useFreebuffSessionStore.getState().setFailure(null)
  useFreebuffChatStore.setState({ admission: starting })
  try {
    await startFreebuffSession(starting.model, {
      preserveQueue: true,
      persistSelection: false,
    })
  } catch (error) {
    if (useFreebuffChatStore.getState().admission !== starting) return
    useFreebuffChatStore.setState({
      admission: {
        ...starting,
        phase: 'failed',
        message: error instanceof Error ? error.message : String(error),
      },
    })
  }
}

/** The queue holds the submitted text and attachments while admission runs. */
export function useFreebuffChatAdmission(enabled: boolean) {
  const checking = useRef<ChatAdmission | null>(null)
  const admission = useFreebuffChatStore((s) => s.admission)
  const session = useFreebuffSessionStore((s) => s.session)
  const failure = useFreebuffSessionStore((s) => s.failure)

  useEffect(() => {
    if (!enabled || !admission) return
    if (admission.phase === 'starting') {
      if (failure && !failure.retry) {
        useFreebuffChatStore.setState({
          admission: {
            ...admission,
            phase: 'failed',
            message: failure.message,
          },
        })
      } else if (session === admission.previousSession) {
        return
      } else if (session?.status === 'active') {
        useFreebuffChatStore.setState({ admission: null, nextModel: null })
      } else {
        const message = freebuffAdmissionNotice(session)
        if (message)
          useFreebuffChatStore.setState({
            admission: { ...admission, phase: 'failed', message },
          })
      }
      return
    }
    if (admission.phase !== 'requested') return
    if (!session) {
      if (failure && !failure.retry)
        useFreebuffChatStore.setState({
          admission: {
            ...admission,
            phase: 'failed',
            message: failure.message,
          },
        })
      return
    }
    if (!admission.metadataChecked) {
      if (checking.current === admission) return
      checking.current = admission
      void refreshFreebuffSessionMetadata()
        .then(() => {
          if (useFreebuffChatStore.getState().admission === admission)
            useFreebuffChatStore.setState({
              admission: { ...admission, metadataChecked: true },
            })
        })
        .catch((error) => {
          if (useFreebuffChatStore.getState().admission === admission)
            useFreebuffChatStore.setState({
              admission: {
                ...admission,
                phase: 'failed',
                message: error instanceof Error ? error.message : String(error),
              },
            })
        })
      return
    }
    if (session.status === 'banned' || session.status === 'country_blocked') {
      useFreebuffChatStore.setState({
        admission: {
          ...admission,
          phase: 'failed',
          message: freebuffAdmissionNotice(session)!,
        },
      })
      return
    }
    const model = resolveFreebuffModelPickForSession(admission.model, session)
    const intent = freebucksRowIntent(
      freebucksOf(session),
      model,
      session.status === 'active' ? session.model : undefined,
    )
    const resolved = { ...admission, model }
    if (intent.kind === 'paywall') {
      useFreebuffChatStore.setState({
        admission: {
          ...resolved,
          phase: 'failed',
          message: `Not enough Freebucks for ${getFreebuffModelDirectory().get(model).displayName} (${freebucksPriceLabel(intent.price)}). Choose another model with /model or visit https://freebuff.com/plans.`,
        },
      })
    } else if (
      intent.kind === 'confirm' ||
      (session.status === 'active' && session.model !== model)
    ) {
      const cost =
        intent.price === undefined
          ? freebucksOf(session) === null
            ? 'may spend wallet Freebucks'
            : 'starts a new session'
          : `costs ${freebucksPriceLabel(intent.price)}`
      const wallet =
        intent.kind === 'confirm' && intent.walletSpend
          ? ` Uses ${formatFreebucks(intent.walletSpend)} from your wallet.`
          : ''
      useFreebuffChatStore.setState({
        admission: {
          ...resolved,
          phase: 'confirm',
          previousSession: session,
          message: `${getFreebuffModelDirectory().get(model).displayName} ${cost}.${wallet}${session.status === 'active' ? ' This ends your current model session; your conversation is kept.' : ''}${intent.kind === 'confirm' && 'claimEarned' in intent && intent.claimEarned ? ' Earned Freebucks will be claimed on admission.' : ''}`,
        },
      })
    } else {
      // Keep the exact object used by the asynchronous admission continuation.
      useFreebuffChatStore.setState({ admission: resolved })
      void beginFreebuffChatAdmission(resolved)
    }
  }, [enabled, admission, session, failure])
}
