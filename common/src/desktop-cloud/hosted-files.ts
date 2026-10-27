import type { FileImage } from './image-files'
import type { HostedBrowserScope } from './hosted-workspace'

/** Relative paths only. Native code selects and authorizes the chat's directory. */
export type HostedFilesRequest = HostedBrowserScope & (
  | { operation: 'list'; directory?: string; query?: string }
  | { operation: 'read'; path: string; expanded: boolean }
  | { operation: 'save'; path: string; content: string; revision: string }
  | { operation: 'create'; path: string; kind: 'file' | 'directory' }
)

export type HostedFileReadResult =
  | { ok: true; content: string; truncated: boolean; revision: string; image?: FileImage; readOnly?: boolean; tooLargeToEdit?: boolean }
  | { ok: false; error: string; canExpand?: boolean }

export type HostedFilesResponses = {
  list: { files: Array<{ path: string; name: string; kind: 'file' | 'directory'; depth: number }> }
  read: HostedFileReadResult
  save: { ok: true; revision: string } | { ok: false; error: string; conflict?: boolean }
  create: { ok: true } | { ok: false; error: string }
}

export type HostedFilesHost = {
  request<T extends HostedFilesRequest>(input: T): Promise<HostedFilesResponses[T['operation']]>
}
