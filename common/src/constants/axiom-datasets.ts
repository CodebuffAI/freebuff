/**
 * The Axiom dataset holding app logs and analytics events (docs/logging.md),
 * and its dev twin. Every writer and reader defaults to these, so a move to
 * a fresh dataset is a change here, not across every query.
 */
export const AXIOM_APP_DATASET = 'freebuff'
export const AXIOM_APP_DEV_DATASET = 'freebuff-dev'
