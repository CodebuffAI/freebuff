import type { MessageRow } from '../types/contracts/bigquery'

/**
 * The one key for a BigQuery `message` row (COD-753): BigQuery's `insertId`
 * and the Postgres `message_text_outbox` primary key. One definition, so the
 * outbox and BigQuery's dedupe cannot drift apart.
 *
 * Not the bare message id: Luminal's 32-bit completion ids collide across
 * users (COD-752), and dedupe on the id alone would silently drop the second
 * user's row.
 */
export function messageInsertId(
  row: Pick<MessageRow, 'id' | 'user_id'>,
): string {
  return `${row.id}|${row.user_id}`
}
