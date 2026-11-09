import { assert, test } from 'orca/testing'
import { BAN_MS, ClientError, CpaClient, type FetchLike, MAX_BODY_CHARS, normalizeBaseUrl } from './client'

type Route = { status: number; body?: unknown; raw?: string }
type Call = { url: string; path: string; init: Parameters<FetchLike>[1] }

const QUEUE_V8 = '/v8/management/observability/usage/queue'
const QUEUE_V0 = '/v0/management/usage-queue'
const STATS_V8 = '/v8/management/config/observability/usage/usage-statistics-enabled'
const STATS_V0 = '/v0/management/usage-statistics-enabled'

/** A stand-in server: each path answers its route, or 404. */
function fakeFetch(routes: Record<string, Route | (() => Route)>) {
  const calls: Call[] = []
  const fetch: FetchLike = async (url, init) => {
    const path = new URL(url).pathname
    calls.push({ url, path, init })
    const entry = routes[path]
    const route = typeof entry === 'function' ? entry() : (entry ?? { status: 404, body: { error: 'not_found' } })
    return {
      status: route.status,
      ok: route.status >= 200 && route.status < 300,
      text: async () => route.raw ?? JSON.stringify(route.body ?? '')
    }
  }
  return { fetch, calls, paths: () => calls.map((call) => call.path) }
}

const failsWith = (pattern: RegExp, pause: ClientError['pause'] = 'none') => (error: unknown) =>
  error instanceof ClientError && pattern.test(error.message) && error.pause === pause

test('normalizes pasted base URLs', () => {
  assert.equal(normalizeBaseUrl('https://ai.example.com/'), 'https://ai.example.com')
  assert.equal(normalizeBaseUrl(' https://ai.example.com/v1 '), 'https://ai.example.com')
  assert.equal(normalizeBaseUrl('https://ai.example.com/v8/management/'), 'https://ai.example.com')
  assert.equal(normalizeBaseUrl('https://ai.example.com/v0/management'), 'https://ai.example.com')
  assert.equal(normalizeBaseUrl('https://example.com/cpa/'), 'https://example.com/cpa')
  assert.equal(normalizeBaseUrl('https://user:pw@example.com:8443/?q=1#x'), 'https://example.com:8443')
  assert.throws(() => normalizeBaseUrl(''), failsWith(/Set the CLIProxyAPI URL/))
  assert.throws(() => normalizeBaseUrl(undefined), failsWith(/Set the CLIProxyAPI URL/))
  assert.throws(() => normalizeBaseUrl('ftp://example.com'), failsWith(/must use https/))
})

test('allows plain http only for loopback hosts', () => {
  assert.equal(normalizeBaseUrl('http://127.0.0.1:8317/v8/management/'), 'http://127.0.0.1:8317')
  assert.equal(normalizeBaseUrl('http://localhost:8317'), 'http://localhost:8317')
  assert.equal(normalizeBaseUrl('http://127.1.2.3'), 'http://127.1.2.3')
  assert.equal(normalizeBaseUrl('http://[::1]:8317'), 'http://[::1]:8317')
  for (const remote of [
    'http://cpa.example.com',
    'http://192.168.1.10:8317',
    'http://localhost.example.com',
    'http://127.0.0.1.example.com',
    'http://0.0.0.0:8317'
  ]) {
    assert.throws(() => normalizeBaseUrl(remote), failsWith(/must use https/))
  }
})

test('pops from the v8 queue with the key as a bearer token and refuses redirects', async () => {
  const server = fakeFetch({ [QUEUE_V8]: { status: 200, body: [{ model: 'm' }] }, [STATS_V8]: { status: 200, body: true } })
  const client = new CpaClient('https://x.example.com', 'k', server.fetch)
  assert.deepEqual(await client.pop(500), [{ model: 'm' }])
  assert.equal(server.calls[0].url, `https://x.example.com${QUEUE_V8}?count=500`)
  assert.equal(server.calls[0].init.headers.Authorization, 'Bearer k')
  assert.equal(server.calls[0].init.redirect, 'error')
  assert.equal(server.calls[0].init.method, 'GET')
  assert.ok(server.calls.every((call) => call.init.redirect === 'error'))
  assert.equal(client.version, 'v8')
  assert.equal(client.statisticsEnabled, true)
  assert.ok(client.matches('https://x.example.com', 'k'))
  assert.equal(client.matches('https://x.example.com', 'other'), false)
})

test('falls back to v0, then keeps using it', async () => {
  const server = fakeFetch({
    [QUEUE_V0]: { status: 200, body: [] },
    [STATS_V0]: { status: 200, body: { 'usage-statistics-enabled': true } }
  })
  const client = new CpaClient('https://x.example.com', 'k', server.fetch)
  assert.deepEqual(await client.pop(10), [])
  assert.deepEqual(server.paths(), [QUEUE_V8, QUEUE_V0, STATS_V0])
  assert.equal(client.version, 'v0')
  assert.equal(client.statisticsEnabled, true)

  await client.pop(10)
  assert.deepEqual(server.paths().slice(3), [QUEUE_V0], 'the cached version goes first; no new statistics read')
})

test('finds v8 again after a server upgrade', async () => {
  let upgraded = false
  const server = fakeFetch({
    [QUEUE_V0]: () => (upgraded ? { status: 404 } : { status: 200, body: [] }),
    [QUEUE_V8]: () => (upgraded ? { status: 200, body: [] } : { status: 404 }),
    [STATS_V8]: { status: 200, body: false }
  })
  const client = new CpaClient('https://x.example.com', 'k', server.fetch)
  await client.pop(10)
  assert.equal(client.version, 'v0')
  upgraded = true
  await client.pop(10)
  assert.equal(client.version, 'v8')
  assert.equal(client.statisticsEnabled, false)
})

test('a refused key is not retried on the other path', async () => {
  const server = fakeFetch({ [QUEUE_V8]: { status: 401, body: { error: 'invalid management key' } } })
  const client = new CpaClient('https://x.example.com', 'bad', server.fetch)
  await assert.rejects(client.pop(10), failsWith(/refused the management key/, 'until-key-changes'))
  assert.deepEqual(server.paths(), [QUEUE_V8])
})

test('an IP ban pauses until a time', async () => {
  const server = fakeFetch({
    [QUEUE_V8]: { status: 403, body: { error: 'IP banned due to too many failed attempts. Try again in 29m59s' } }
  })
  const client = new CpaClient('https://x.example.com', 'k', server.fetch, { now: () => 1_000 })
  await assert.rejects(client.pop(10), (error) => {
    assert.ok(error instanceof ClientError)
    assert.equal(error.pause, 'until-time')
    assert.equal(error.retryAt, 1_000 + BAN_MS)
    assert.match(error.message, /banned this IP/)
    return true
  })
  assert.deepEqual(server.paths(), [QUEUE_V8])
})

test('a plain 403 says to allow remote management', async () => {
  const server = fakeFetch({ [QUEUE_V8]: { status: 403, body: { error: 'remote management disabled' } } })
  const client = new CpaClient('https://x.example.com', 'k', server.fetch)
  await assert.rejects(client.pop(10), (error) => {
    assert.ok(error instanceof ClientError)
    assert.equal(error.pause, 'none')
    assert.equal(error.retryAt, null)
    assert.match(error.message, /remote management disabled/)
    assert.match(error.message, /allow-remote: true/)
    return true
  })
})

test('caps the 403 detail at 200 characters', async () => {
  const server = fakeFetch({ [QUEUE_V8]: { status: 403, raw: 'x'.repeat(5000) } })
  const client = new CpaClient('https://x.example.com', 'k', server.fetch)
  await assert.rejects(client.pop(10), (error) => error instanceof ClientError && error.message.length < 400)
})

test('says when no version has a queue', async () => {
  const server = fakeFetch({})
  const client = new CpaClient('https://x.example.com', 'k', server.fetch)
  await assert.rejects(client.pop(10), failsWith(/No usage queue at https:\/\/x\.example\.com/))
  assert.equal(client.version, null)
})

test('a v8 statistics 404 means the switch is off', async () => {
  const server = fakeFetch({ [QUEUE_V8]: { status: 200, body: [] } })
  const client = new CpaClient('https://x.example.com', 'k', server.fetch)
  await client.pop(10)
  assert.deepEqual(server.paths(), [QUEUE_V8, STATS_V8])
  assert.equal(client.statisticsEnabled, false)
})

test('a failed statistics read is unknown and never drops the page', async () => {
  const server = fakeFetch({ [QUEUE_V8]: { status: 200, body: [] }, [STATS_V8]: { status: 500, raw: 'boom' } })
  const client = new CpaClient('https://x.example.com', 'k', server.fetch)
  assert.deepEqual(await client.pop(10), [])
  assert.equal(client.statisticsEnabled, null)

  const refused = fakeFetch({ [QUEUE_V8]: { status: 200, body: [{ model: 'm' }] }, [STATS_V8]: { status: 401 } })
  const other = new CpaClient('https://x.example.com', 'k', refused.fetch)
  assert.deepEqual(await other.pop(10), [{ model: 'm' }])
  assert.equal(other.statisticsEnabled, true, 'a record proves the server publishes usage')
})

test('refuses answers that are too large, not JSON or not a list', async () => {
  const big = fakeFetch({ [QUEUE_V8]: { status: 200, raw: `[${'0,'.repeat(MAX_BODY_CHARS / 2)}0]` } })
  await assert.rejects(new CpaClient('https://x.example.com', 'k', big.fetch).pop(10), failsWith(/larger than/))
  const html = fakeFetch({ [QUEUE_V8]: { status: 200, raw: '<html>login</html>' } })
  await assert.rejects(new CpaClient('https://x.example.com', 'k', html.fetch).pop(10), failsWith(/not JSON/))
  const object = fakeFetch({ [QUEUE_V8]: { status: 200, body: { records: [] } } })
  await assert.rejects(new CpaClient('https://x.example.com', 'k', object.fetch).pop(10), failsWith(/not answer with a list/))
  const failing = fakeFetch({ [QUEUE_V8]: { status: 502, raw: 'bad gateway' } })
  await assert.rejects(
    new CpaClient('https://x.example.com', 'k', failing.fetch).pop(10),
    failsWith(/HTTP 502 from https:\/\/x\.example\.com: bad gateway/)
  )
})

test('reports an unreachable server', async () => {
  const fetch: FetchLike = async () => {
    throw new TypeError('fetch failed')
  }
  await assert.rejects(new CpaClient('https://x.example.com', 'k', fetch).pop(10), failsWith(/Cannot reach https:\/\/x\.example\.com: fetch failed/))
})

test('times out each request', async () => {
  const hang: FetchLike = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason))
    })
  const client = new CpaClient('https://x.example.com', 'k', hang, { timeoutMs: 30 })
  await assert.rejects(client.pop(10), failsWith(/No answer from https:\/\/x\.example\.com within 0\.03 s/))
})

test('passes the caller abort through unchanged', async () => {
  const hang: FetchLike = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason))
    })
  const controller = new AbortController()
  const client = new CpaClient('https://x.example.com', 'k', hang)
  const popping = client.pop(10, controller.signal)
  controller.abort(new Error('stopped'))
  await assert.rejects(popping, (error) => !(error instanceof ClientError))
})
