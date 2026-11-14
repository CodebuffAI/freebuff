/** Leaves room for base64 and request metadata inside existing 24 MiB device frames. */
export const FILE_UPLOAD_MAX_BYTES = 16 * 1024 * 1024
export const FILE_UPLOAD_BASE64_MAX = Math.ceil(FILE_UPLOAD_MAX_BYTES / 3) * 4
export const FILE_UPLOAD_REQUEST_MAX = FILE_UPLOAD_BASE64_MAX + 16 * 1024

export function validFileUploadData(data: unknown): data is string {
  return typeof data === 'string' && data.length <= FILE_UPLOAD_BASE64_MAX && data.length % 4 === 0 &&
    /^[A-Za-z0-9+/]*={0,2}$/.test(data)
}
