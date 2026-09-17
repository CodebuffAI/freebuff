/**
 * How long an off-Cloud sponsored run may report on itself (COD-396).
 *
 * Accept on Desktop or the CLI hands the surface a signed run token, and every
 * state report presents it. The lifetime is the answer to one question: a
 * laptop closed mid-run should still be able to say `failed` the next morning,
 * because a row nobody can move is a card the user is stuck with.
 *
 * IT LIVES IN `common` BECAUSE TWO RUNTIMES HAVE TO AGREE ON IT. The Next
 * route mints and verifies against this; Convex's stale sweep uses it as the
 * point at which an off-Cloud row that nobody ever reported on may be failed —
 * which is exactly "the token that could have rescued it has expired". Two
 * separately-maintained constants would drift into a window where a surface's
 * token still verifies against a row the sweep has already given up on, and
 * the honest report would be answered 409.
 *
 * Deliberately NOT the Cloud executor's `SPONSORED_EXECUTION_TIMEOUT_MS`
 * (~45 minutes). That one bounds work OUR infrastructure is doing and can
 * observe; this one bounds work on a machine we cannot see, which legitimately
 * pauses for as long as the person using it does.
 */
export const SPONSORED_RUN_TOKEN_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Reporting grace for observing the recorded PR after execution authority
 * expires. Only the state route's `merged` report opts into this bound.
 */
export const SPONSORED_MERGE_REPORT_TTL_MS = 30 * 24 * 60 * 60 * 1000
