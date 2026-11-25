/**
 * The end user's own user agent on a Cloud send that our Freebuff Web
 * workspace gateway relays: the gateway's fetch carries its own runtime's UA,
 * so it forwards the browser's or phone app's here. The Cloud API records it
 * with the run for Gravity's per-search `user_agent` (web
 * desktop-cloud/end-user.ts). Like the UA itself it proves nothing, so any
 * caller may send it; the end user's IP travels only in the signed client
 * relay (`CLIENT_RELAY_HEADER`).
 */
export const CLOUD_END_USER_AGENT_HEADER = 'x-freebuff-end-user-agent'

/** Gravity's `user_agent` cap (common/src/types/gravity-index.ts). */
export const CLOUD_END_USER_AGENT_MAX_CHARS = 1024
