/**
 * Sent by the SDK on every chat-completions request to our backend: this
 * build recovers a gzip SSE body that ends before the gzip stream does (Bun's
 * `ZlibError`, a cut connection during a web deploy) by continuing the turn
 * instead of failing it (COD-764, `TRANSIENT_NETWORK_ERROR_CODES` in
 * common/src/util/error.ts).
 *
 * The server gzips the stream only for requests carrying it
 * (web/src/app/api/v1/chat/completions/sse-compression-gate.ts). Builds from
 * before the recovery send no header and get the uncompressed stream, which a
 * cut ends cleanly and they already continue from.
 */
export const FREEBUFF_SSE_GZIP_RECOVERY_HEADER = 'x-freebuff-sse-gzip-recovery'
export const FREEBUFF_SSE_GZIP_RECOVERY_VALUE = '1'
