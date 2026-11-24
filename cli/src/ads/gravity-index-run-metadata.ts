import { useChatStore } from '../state/chat-store'
import { getCliAdRequestUserAgent } from '../utils/ad-client-identity'

/**
 * The run metadata the `gravity_index` handler copies into a search, so
 * Gravity can join an Index recommendation to this user's ad traffic: the
 * SAME `sessionId` the CLI sends on its ad requests (the chat's
 * `chatSessionId`, regenerated on a new chat) and the SAME User-Agent header
 * they carry (`Freebuff-CLI/<v>`), which is what Gravity sees on ads
 * (`resolveGravityUserAgent`: the header wins). Read from the sources
 * `buildAdAuctionRequest` reads, never copied, so the two cannot drift.
 *
 * No IP: the CLI calls the API from the user's machine, so the request's own
 * address is already the user's.
 */
export function gravityIndexRunMetadata(): Record<string, string> {
  return {
    gravity_ad_session_id: useChatStore.getState().chatSessionId,
    gravity_end_user_agent: getCliAdRequestUserAgent(),
  }
}
