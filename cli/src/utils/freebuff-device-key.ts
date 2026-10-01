/**
 * This install's device key and the request signing built on it
 * (docs/freebuff-model-catalog.md; the protocol is
 * `common/src/util/freebuff-device-signing.ts`).
 *
 * The key pair lives in `device-key.json` in the CLI config dir
 * (`getConfigDir()`, so FREEBUFF_CONFIG_DIR profiles each have their own),
 * owner read/write only, beside `credentials.json`. It holds the private key
 * and the key id the server returned per account and API host; nothing in it
 * is a credential for anything but this install's own signatures.
 *
 * What is signed: the catalog GET, and every session and completions request
 * while a catalog is held (catalog mode). The key is registered only once this
 * process holds a catalog. Signing errors never throw into the request path.
 */
import fs from 'fs'
import path from 'path'

import { IS_TEST } from '@codebuff/common/env'
import { FREEBUFF_CATALOG_FETCH_HEADER } from '@codebuff/common/types/freebuff-model-catalog'
import {
  FreebuffDeviceSigner,
  isFreebuffDeviceKeyUnknownError,
  parseFreebuffDeviceKeyRecord,
} from '@codebuff/common/util/freebuff-device-signing'

import { getFreebuffCatalog } from '../state/freebuff-catalog-store'
import { getUserCredentials } from './auth'
import { getConfigDir } from './config-dir'
import { logger } from './logger'

import type {
  FreebuffDeviceKeyRecord,
  FreebuffDeviceKeyStore,
  FreebuffDeviceRequest,
} from '@codebuff/common/util/freebuff-device-signing'

const DEVICE_KEY_FILE_MODE = 0o600
const CONFIG_DIR_MODE = 0o700

export function freebuffDeviceKeyPath(configDir: string = getConfigDir()): string {
  return path.join(configDir, 'device-key.json')
}

/** `device-key.json`, written atomically and owner-only. */
export function createFreebuffDeviceKeyFileStore(
  filePath: string,
): FreebuffDeviceKeyStore {
  return {
    async load() {
      let raw: string
      try {
        raw = await fs.promises.readFile(filePath, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
      // A file this build cannot read is replaced: the key is this install's
      // own, and a new one only costs a registration.
      try {
        return parseFreebuffDeviceKeyRecord(JSON.parse(raw))
      } catch {
        return null
      }
    },
    async save(record: FreebuffDeviceKeyRecord) {
      await fs.promises.mkdir(path.dirname(filePath), {
        recursive: true,
        mode: CONFIG_DIR_MODE,
      })
      const tmp = `${filePath}.${process.pid}.tmp`
      try {
        await fs.promises.writeFile(tmp, JSON.stringify(record), {
          mode: DEVICE_KEY_FILE_MODE,
        })
        // `mode` applies only on create; a leftover tmp keeps its own
        if (process.platform !== 'win32')
          await fs.promises.chmod(tmp, DEVICE_KEY_FILE_MODE)
        await fs.promises.rename(tmp, filePath)
      } catch (error) {
        await fs.promises.rm(tmp, { force: true }).catch(() => {})
        throw error
      }
    },
  }
}

// undefined: not built yet; null: signing is off for this process
let signer: FreebuffDeviceSigner | null | undefined

function getSigner(): FreebuffDeviceSigner | null {
  if (signer !== undefined) return signer
  // Tests never write to the developer's config dir or register a key over
  // the network; they install their own signer.
  if (IS_TEST) return (signer = null)
  try {
    signer = new FreebuffDeviceSigner({
      store: createFreebuffDeviceKeyFileStore(freebuffDeviceKeyPath()),
      client: 'cli',
      log: (message) => logger.debug({}, message),
    })
  } catch (error) {
    logger.debug(
      { error: error instanceof Error ? error.message : String(error) },
      '[device-key] signing unavailable',
    )
    signer = null
  }
  return signer
}

/** Replace the process's signer (tests); null turns signing off. */
export function setFreebuffDeviceSigner(next: FreebuffDeviceSigner | null): void {
  signer = next
}

function accountFor(token: string, url: string) {
  let accountId: string | undefined
  try {
    const user = getUserCredentials()
    // the id only names the account a token belongs to when it IS that token
    if (user?.authToken === token) accountId = user.id
  } catch {
    // no credentials file: the account is identified by its token
  }
  return { token, accountId, apiHost: new URL(url).origin }
}

/**
 * The device headers for one request (key id, timestamp, signature), or none.
 * Never throws; waits a bounded time for a first registration.
 */
export async function freebuffDeviceHeaders(
  token: string,
  request: FreebuffDeviceRequest,
  options: { register?: boolean } = {},
): Promise<Record<string, string>> {
  const active = getSigner()
  if (!active) return {}
  try {
    return await active.headers(accountFor(token, request.url), request, options)
  } catch {
    return {}
  }
}

/**
 * A response's error code said the server does not know the device key a
 * request named: forget the key id, so the next request registers again.
 */
export function noteFreebuffDeviceKeyError(
  token: string,
  url: string,
  errorCode: string | null | undefined,
): void {
  if (!isFreebuffDeviceKeyUnknownError(errorCode)) return
  getSigner()?.forgetRegistration(accountFor(token, url))
}

/**
 * The SDK's `requestHeaders` hook for completions (codebuff-client.ts): in
 * catalog mode, the held catalog's fetch id and a signature over the exact
 * body the SDK sends; in fallback mode, nothing, so the request is unchanged.
 */
export async function freebuffCatalogCompletionHeaders(
  token: string,
  request: { method: string; url: string; body: string | Uint8Array | undefined },
): Promise<Record<string, string>> {
  const catalog = getFreebuffCatalog()
  if (!catalog) return {}
  const fetchId = catalog.fetchId
  return {
    ...(fetchId ? { [FREEBUFF_CATALOG_FETCH_HEADER]: fetchId } : {}),
    ...(await freebuffDeviceHeaders(token, { ...request, fetchId })),
  }
}
