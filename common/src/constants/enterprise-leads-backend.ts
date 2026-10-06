/**
 * Which store owns /enterprise contact-form leads (Convex `enterprise_leads`;
 * Postgres `enterprise_lead`, migration 0342) — the checked-in switch for
 * moving them off platform Convex (COD-742 Wave A2, light tier; runbook in
 * docs/convex-retirement-wave-a.md, "Enterprise leads").
 *
 * - `convex`   (default): `/api/enterprise-contact` records the lead and its
 *              email outcome through the secret-gated `enterprise_leads:*`
 *              mutations, exactly as before the port. Nothing in the
 *              Postgres port runs.
 * - `postgres` the route writes Postgres on the primary: the INSERT and, after
 *              the send, the email outcome. The Convex functions stay
 *              deployed as the rollback.
 *
 * Neither backend copies a lead into the feedback hub: the hub is frozen
 * (docs/freebuff-feedback-hub.md).
 *
 * Imported by Convex as well as by the Next servers, so it must stay a leaf.
 * A flip is a reviewed one-line diff here, never an env var; the revert is the
 * same diff while the Convex functions still exist.
 */
export type EnterpriseLeadsBackend = 'convex' | 'postgres'

export const ENTERPRISE_LEADS_BACKEND: EnterpriseLeadsBackend = 'convex'

/** Whether `backend` serves enterprise leads from Postgres. */
export function enterpriseLeadsOnPostgres(
  backend: EnterpriseLeadsBackend = ENTERPRISE_LEADS_BACKEND,
): boolean {
  return backend === 'postgres'
}
