import { afterEach, expect, spyOn, test } from 'bun:test'

import {
  setFreebuffCatalog,
  useFreebuffCatalogStore,
} from '../../state/freebuff-catalog-store'
import {
  callFreebuffSession,
  FreebuffSessionRequestError,
} from '../freebuff-session-api'
import { catalogFixture, catalogRow, rotateHandles } from './freebuff-catalog-fixtures'

const CATALOG = catalogFixture([catalogRow('m-flash'), catalogRow('m-mimo')])

let fetchSpy: ReturnType<typeof spyOn> | undefined

afterEach(() => {
  fetchSpy?.mockRestore()
  fetchSpy = undefined
  setFreebuffCatalog(null)
  useFreebuffCatalogStore.setState({ refreshAfterStale: null })
})

const headersOf = (call: unknown[]) =>
  new Headers((call[1] as RequestInit | undefined)?.headers)

const stale = () =>
  new Response(JSON.stringify({ error: 'freebuff_catalog_stale' }), {
    status: 409,
    headers: { 'content-type': 'application/json' },
  })

test('fallback mode sends neither the protocol header nor a handle', async () => {
  fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({ status: 'none' }),
  )
  await callFreebuffSession('POST', 'tok', { model: 'mimo/mimo-v2.5' })
  const headers = headersOf(fetchSpy.mock.calls[0]!)
  expect(headers.get('x-freebuff-catalog-protocol')).toBeNull()
  expect(headers.get('x-freebuff-model')).toBe('mimo/mimo-v2.5')
})

test('catalog mode sends the protocol header on every call and the handle for a key', async () => {
  setFreebuffCatalog(CATALOG)
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () =>
    Response.json({ status: 'none' })) as unknown as typeof fetch)
  await callFreebuffSession('POST', 'tok', { model: 'm-flash' })
  await callFreebuffSession('GET', 'tok', { instanceId: 'i1' })
  await callFreebuffSession('DELETE', 'tok', { instanceId: 'i1' })
  const [post, get, del] = fetchSpy.mock.calls.map(headersOf)
  expect(post!.get('x-freebuff-model')).toBe('fbm1.m-flash-h1')
  for (const headers of [post!, get!, del!]) {
    expect(headers.get('x-freebuff-catalog-protocol')).toBe('1')
  }
})

test('a stale handle refetches the catalog once and retries with the new handle', async () => {
  setFreebuffCatalog(CATALOG)
  let refreshes = 0
  useFreebuffCatalogStore.setState({
    refreshAfterStale: async () => {
      refreshes++
      setFreebuffCatalog(rotateHandles(CATALOG, 2))
      return true
    },
  })
  fetchSpy = spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(stale())
    .mockResolvedValueOnce(
      Response.json({ status: 'none', accessTier: 'full' }),
    )
  const response = await callFreebuffSession('POST', 'tok', {
    model: 'm-flash',
  })
  expect(response.status).toBe('none')
  expect(refreshes).toBe(1)
  expect(fetchSpy.mock.calls.map((c: unknown[]) => headersOf(c).get('x-freebuff-model')))
    .toEqual(['fbm1.m-flash-h1', 'fbm1.m-flash-h2'])
})

test('a second stale answer is surfaced, not retried again', async () => {
  setFreebuffCatalog(CATALOG)
  useFreebuffCatalogStore.setState({
    refreshAfterStale: async () => {
      setFreebuffCatalog(rotateHandles(CATALOG, 2))
      return true
    },
  })
  fetchSpy = spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(stale())
    .mockResolvedValueOnce(stale())
  const error = await callFreebuffSession('POST', 'tok', {
    model: 'm-flash',
  }).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(FreebuffSessionRequestError)
  expect((error as FreebuffSessionRequestError).errorCode).toBe(
    'freebuff_catalog_stale',
  )
  expect(fetchSpy).toHaveBeenCalledTimes(2)
})

test('when the catalog cannot be refetched the stale error is surfaced', async () => {
  setFreebuffCatalog(CATALOG)
  useFreebuffCatalogStore.setState({ refreshAfterStale: async () => false })
  fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(stale())
  await expect(
    callFreebuffSession('GET', 'tok', { instanceId: 'i1' }),
  ).rejects.toBeInstanceOf(FreebuffSessionRequestError)
  expect(fetchSpy).toHaveBeenCalledTimes(1)
})
