/** Bounded, content-free metadata shared by the device API and native client. */
export const DEVICE_REQUEST_ID_HEADER = 'x-freebuff-device-request-id'
export const DEVICE_ERROR_CODE_HEADER = 'x-freebuff-device-error-code'

export const deviceFailureReasons = {
  DEVICE_FOLDER_LIMIT: 'Account device folder limit reached',
  PROJECT_DEVICE_MISMATCH: 'This project belongs to a local folder. Reconnect its computer to continue.',
  PROJECT_STORAGE_MISMATCH: 'Cloud project storage configuration does not match',
  PROJECT_ALREADY_OCCUPIED: 'This project already has Cloud files or a different local folder',
} as const

export function deviceFailureCode(value: unknown): string | undefined {
  return typeof value === 'string' &&
    (Object.hasOwn(deviceFailureReasons, value) || ['DEVICE_REQUEST_REJECTED', 'DEVICE_REQUEST_UNEXPECTED'].includes(value))
    ? value : undefined
}

export function deviceRequestId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)
    ? value : undefined
}

/** Never return a raw path, session ID, query, or user-controlled route segment. */
export function deviceRequestOperation(path: string): string {
  const parts = path.split('?')[0].split('/')
  const operation = parts.length === 1 ? parts[0] : parts.length === 2 ? parts[1] : ''
  return ['capabilities', 'devices', 'register', 'prepare-chat', 'panels', 'read', 'chat',
    'project', 'panel-authorize', 'panel-results', 'active-runs', 'events', 'authorize',
    'progress', 'results', 'connection'].includes(operation) ? operation : 'unknown'
}
