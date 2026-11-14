import type { FileImage } from './image-files'
import type { FileMedia } from './media-files'
import type { HostedBrowserScope } from './hosted-workspace'

/** Relative paths only. Native code selects and authorizes the chat's directory. */
export type HostedFilesRequest = HostedBrowserScope & (
  | { operation: 'list'; directory?: string; query?: string }
  | { operation: 'read'; path: string; expanded: boolean }
  | { operation: 'save'; path: string; content: string; revision: string }
  | { operation: 'create'; path: string; kind: 'file' | 'directory' }
  | { operation: 'upload'; path: string; data: string }
  /** Original file bytes, in bounded chunks; also available through the device relay. */
  | { operation: 'download'; path: string; offset: number }
  /** Desktop IPC only (the device relay rejects it): the file's absolute path on this computer. */
  | { operation: 'locate'; path: string }
  /** Desktop IPC only: up to `MEDIA_CHUNK_BYTES` of a playable file from `offset`, so the hosted
   * page can play a file whose bytes it can't reach over HTTP. */
  | { operation: 'media'; path: string; offset: number }
)

export type HostedFileReadResult =
  | { ok: true; content: string; truncated: boolean; revision: string; image?: FileImage; media?: FileMedia; readOnly?: boolean; tooLargeToEdit?: boolean }
  | { ok: false; error: string; canExpand?: boolean; reason?: 'binary' | 'too_large'; size?: number }

export type HostedFilesResponses = {
  list: { files: Array<{ path: string; name: string; kind: 'file' | 'directory'; depth: number }> }
  read: HostedFileReadResult
  save: { ok: true; revision: string } | { ok: false; error: string; conflict?: boolean }
  create: { ok: true } | { ok: false; error: string }
  upload: { ok: true } | { ok: false; error: string }
  locate: { path: string }
  /** `data` is base64. `revision` changes when the file does, so a reader can restart. */
  media: { data: string; size: number; revision: string }
  download: { data: string; size: number; revision: string }
}

export type HostedFilesHost = {
  request<T extends HostedFilesRequest>(input: T): Promise<HostedFilesResponses[T['operation']]>
  /** Shows the file in Finder or the platform's file manager; absent before Desktop supported it. */
  reveal?(input: HostedBrowserScope & { path: string }): Promise<void>
  /** A private `freebuff-media:` URL that streams a playable file from this computer by byte
   * range, never through a server. Absent before Desktop supported it. */
  mediaUrl?(input: HostedBrowserScope & { path: string }): Promise<string>
}
