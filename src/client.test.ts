import { assert, test } from 'orca/testing'
import { MAX_ACCOUNTS } from './accounts'
import {
  API_CALL_TIMEOUT_MS,
  BAN_MS,
  ClientError,
  CpaClient,
  type FetchLike,
  MAX_BODY_BYTES,
  MAX_UPSTREAM_BODY_CHARS,
  normalizeBaseUrl
} from './client'
import { answer, credentialsV0, credentialsV8, fakeServer, PATHS, UPSTREAM } from './fixtures'
import type { UpstreamRequest } from './providers'

const BASE = 'https://x.example.com'
const MGMT_KEY = 'mgmt-key-1'
const { credentials: CREDENTIALS_V8, apiCall: CALL_V8 } = PATHS.v8
const { credentials: CREDENTIALS_V0, apiCall: CALL_V0 } = PATHS.v0
const CLAUDE_USAGE: UpstreamRequest = {
  method: 'GET',
  url: UPSTREAM.claudeUsage,
  header: { Authorization: 'Bearer $TOKEN$' }
}

type Route = { status: number; body?: unknown; raw?: string; headers?: Record<string, string> }
type Call = { url: string; path: string; init: Parameters<FetchLike>[1] }

/** A stand-in server: each path answers its route, or 404. */
function fakeFetch(routes: Record<string, Route | (() => Route)>) {
  const calls: Call[] = []
  const fetch: FetchLike = async (url, init) => {
    const path = new URL(url).pathname
    calls.push({ url, path, init })
    const entry = routes[path]
    const route = typeof entry === 'function' ? entry() : (entry ?? { status: 404, body: { error: 'not_found' } })
    return answer(route.status, route.raw ?? JSON.stringify(route.body ?? ''), route.headers)
  }
  return { fetch, calls, paths: () => calls.map((call) => call.path) }
}

const failsWith = (pattern: RegExp, pause: ClientError['pause']['kind'] = 'none') => (error: unknown) =>
  error instanceof ClientError && pattern.test(error.message) && error.pause.kind === pause

const hang: FetchLike = (_url, init) =>
  new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason))
  })

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

test('lists v8 credentials with the key as a bearer token and refuses redirects', async () => {
  const server = fakeFetch({ [CREDENTIALS_V8]: { status: 200, body: credentialsV8() } })
  const client = new CpaClient(BASE, MGMT_KEY, server.fetch)
  const { accounts, omitted } = await client.listAccounts()
  assert.equal(omitted, 0)
  assert.equal(server.calls[0].url, `${BASE}${CREDENTIALS_V8}`)
  assert.equal(server.calls[0].init.method, 'GET')
  assert.equal(server.calls[0].init.headers.Authorization, `Bearer ${MGMT_KEY}`)
  assert.equal(server.calls[0].init.redirect, 'error')
  assert.equal(client.version, 'v8')
  assert.deepEqual(accounts[0], {
    id: 'a1',
    authIndex: 'a1',
    name: 'claude-me.json',
    provider: 'claude',
    email: 'me@example.com',
    label: null,
    disabled: false,
    details: {}
  })
  assert.deepEqual(accounts[1].details, { chatgptAccountId: 'acct-123', planType: 'plus' })
  assert.deepEqual(accounts[2].details, { projectId: 'proj-42' })
  assert.equal(accounts[3].disabled, true)
  assert.equal(accounts[4].provider, 'gemini-cli', 'provider is lower case with - for _')
  assert.ok(client.matches(BASE, MGMT_KEY))
  assert.equal(client.matches(BASE, 'other'), false)
})

test('falls back to v0 for both the list and api-call, then keeps using it', async () => {
  const server = fakeServer({ keys: [MGMT_KEY], layout: 'v0' })
  const client = new CpaClient(BASE, MGMT_KEY, server.fetch)
  const { accounts } = await client.listAccounts()
  assert.deepEqual(accounts.map((account) => [account.id, account.provider]), [['a1', 'claude']])
  assert.equal(client.version, 'v0')
  const reply = await client.apiCall('a1', CLAUDE_USAGE)
  assert.ok('status' in reply && reply.status === 200)
  assert.deepEqual(
    server.requests.map((request) => request.path),
    [CREDENTIALS_V8, CREDENTIALS_V0, CALL_V0],
    'the cached version goes first'
  )
})

test('finds v8 again after a server upgrade', async () => {
  const server = fakeServer({ keys: [MGMT_KEY], layout: 'v0' })
  const client = new CpaClient(BASE, MGMT_KEY, server.fetch)
  await client.listAccounts()
  assert.equal(client.version, 'v0')
  server.layout = 'v8'
  server.credentials = credentialsV8()
  await client.listAccounts()
  assert.equal(client.version, 'v8')
  assert.deepEqual(server.requests.slice(2).map((request) => request.path), [CREDENTIALS_V0, CREDENTIALS_V8])
})

test('says when neither version has a management API, for the list and for api-call alike', async () => {
  const client = new CpaClient(BASE, MGMT_KEY, fakeFetch({}).fetch)
  await assert.rejects(client.listAccounts(), failsWith(/No management API at https:\/\/x\.example\.com.*6\.6\.63/))
  assert.equal(client.version, null)
  // It concerns every account, so it is thrown, not delivered.
  await assert.rejects(client.apiCall('a1', CLAUDE_USAGE), failsWith(/No management API/))
})

test('validates and caps what the credential list says', async () => {
  const files = [
    null,
    'text',
    [],
    { auth_index: 7, name: 'n'.repeat(500), type: 'Claude_Code', email: 'a\u0000b\u202e@x' },
    { auth_index: 7, name: 'duplicate of 7' },
    { name: 'no-index.json', provider: 'codex', disabled: 'yes', id_token: { chatgpt_account_id: '$TOKEN$', plan_type: 'plus\r\nX: y' } },
    { auth_index: { nested: true }, name: 'odd.json', provider: 42, project_id: 'not-for-this-provider' },
    { auth_index: 'p', provider: 'antigravity', project_id: 'my-proj:1.x', label: 'Work' },
    { auth_index: 'q', provider: 'antigravity', project_id: 'bad project!' },
    { auth_index: 'r', provider: 'codex', chatgpt_account_id: 'top-level-id' }
  ]
  const client = new CpaClient(BASE, MGMT_KEY, fakeFetch({ [CREDENTIALS_V8]: { status: 200, body: { files } } }).fetch)
  const { accounts } = await client.listAccounts()
  assert.deepEqual(accounts.map((account) => account.id), ['7', 'name:no-index.json', 'name:odd.json', 'p', 'q', 'r'])
  const [numeric, noIndex, odd, labelled, badProject, topLevel] = accounts
  assert.equal(numeric.name.length, 200)
  assert.equal(numeric.provider, 'claude-code')
  assert.equal(numeric.email, 'ab@x')
  assert.equal(noIndex.authIndex, null)
  assert.equal(noIndex.disabled, false, 'only true disables')
  assert.deepEqual(noIndex.details, {}, 'entry fields are checked, so no $TOKEN$ or line break gets into a request')
  assert.equal(odd.provider, 'unknown')
  assert.deepEqual(odd.details, {}, 'only the fields of the account\'s own provider are read')
  assert.deepEqual(labelled.details, { projectId: 'my-proj:1.x' })
  assert.equal(labelled.label, 'Work')
  assert.equal(labelled.name, 'unnamed')
  assert.deepEqual(badProject.details, {})
  assert.deepEqual(topLevel.details, { chatgptAccountId: 'top-level-id' })
})

test('keeps at most MAX_ACCOUNTS accounts and counts the rest', async () => {
  const files = Array.from({ length: MAX_ACCOUNTS + 5 }, (_, index) => ({ auth_index: `i${index}`, provider: 'claude' }))
  const client = new CpaClient(BASE, MGMT_KEY, fakeFetch({ [CREDENTIALS_V8]: { status: 200, body: { files } } }).fetch)
  const { accounts, omitted } = await client.listAccounts()
  assert.equal(accounts.length, MAX_ACCOUNTS)
  assert.equal(omitted, 5)
})

test('refuses credential answers that are not JSON, without files or failing', async () => {
  const html = fakeFetch({ [CREDENTIALS_V8]: { status: 200, raw: '<html>login</html>' } })
  await assert.rejects(new CpaClient(BASE, MGMT_KEY, html.fetch).listAccounts(), failsWith(/not JSON/))
  const list = fakeFetch({ [CREDENTIALS_V8]: { status: 200, body: [] } })
  await assert.rejects(new CpaClient(BASE, MGMT_KEY, list.fetch).listAccounts(), failsWith(/files list/))
  const failing = fakeFetch({ [CREDENTIALS_V8]: { status: 500, body: { error: 'internal' } } })
  await assert.rejects(new CpaClient(BASE, MGMT_KEY, failing.fetch).listAccounts(), failsWith(/HTTP 500: internal/))
})

test('refuses an answer too large by its Content-Length before reading it', async () => {
  let pulled = 0
  const fetch: FetchLike = async () => ({
    status: 200,
    headers: new Headers({ 'Content-Length': String(MAX_BODY_BYTES + 1) }),
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1
        controller.enqueue(new Uint8Array(1024))
      }
    })
  })
  await assert.rejects(new CpaClient(BASE, MGMT_KEY, fetch).listAccounts(), failsWith(/larger than/))
  assert.ok(pulled <= 1, 'the body is not read')
})

test('stops reading a body once it passes the cap, and cancels the stream', async () => {
  let sent = 0
  let cancelled = false
  const chunk = 64 * 1024
  const fetch: FetchLike = async () => ({
    status: 200,
    headers: new Headers(),
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += chunk
        controller.enqueue(new Uint8Array(chunk).fill(48))
      },
      cancel() {
        cancelled = true
      }
    })
  })
  await assert.rejects(new CpaClient(BASE, MGMT_KEY, fetch).listAccounts(), failsWith(new RegExp(`larger than ${MAX_BODY_BYTES} bytes`)))
  assert.ok(sent <= MAX_BODY_BYTES + 4 * chunk, `${sent} bytes pulled`)
  assert.ok(cancelled, 'the stream is cancelled')
})

test('api-call posts the fixed request and hands back the upstream status, even 401', async () => {
  const server = fakeServer({ keys: [MGMT_KEY] })
  server.upstream = () => ({ status: 401, body: { error: 'token expired' } })
  const client = new CpaClient(BASE, MGMT_KEY, server.fetch)
  const reply = await client.apiCall('a1', { ...CLAUDE_USAGE, header: { ...CLAUDE_USAGE.header, 'User-Agent': 'ua' } })
  assert.deepEqual(reply, { status: 401, body: '{"error":"token expired"}' })
  const [request] = server.requests
  assert.equal(request.path, CALL_V8)
  assert.equal(request.method, 'POST')
  assert.deepEqual(JSON.parse(request.body ?? ''), {
    auth_index: 'a1',
    method: 'GET',
    url: UPSTREAM.claudeUsage,
    header: { Authorization: 'Bearer $TOKEN$', 'User-Agent': 'ua' }
  })

  await client.apiCall('c3', {
    method: 'POST',
    url: UPSTREAM.antigravity[2],
    header: {},
    data: '{"project":"p"}'
  })
  assert.equal(server.apiCalls[1].data, '{"project":"p"}')
})

test('api-call refuses any request off the allowlist before sending', async () => {
  const server = fakeServer({ keys: [MGMT_KEY] })
  const client = new CpaClient(BASE, MGMT_KEY, server.fetch)
  for (const request of [
    { method: 'POST', url: 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume', header: {} },
    { method: 'GET', url: 'https://evil.example.com/collect', header: { Authorization: 'Bearer $TOKEN$' } },
    { ...CLAUDE_USAGE, url: `${CLAUDE_USAGE.url}?leak=1` }
  ] as UpstreamRequest[]) {
    await assert.rejects(client.apiCall('a1', request), failsWith(/not a quota request/))
  }
  assert.equal(server.requests.length, 0)
})

test('a management 401 on api-call is a refused key; api-call errors of one account are deliveries', async () => {
  const refused = fakeServer({ keys: ['other'] })
  await assert.rejects(
    new CpaClient(BASE, 'bad', refused.fetch).apiCall('a1', CLAUDE_USAGE),
    failsWith(/refused the management key/, 'key-refused')
  )
  assert.equal(refused.requests.length, 1, 'a refused key is not retried on the other path')

  const server = fakeServer({ keys: [MGMT_KEY] })
  server.apiCallErrors.set('a1', { status: 400, body: { error: 'auth token refresh failed' } })
  server.apiCallErrors.set('b2', { status: 502, body: { error: 'request failed' } })
  server.apiCallErrors.set('c3', { status: 500, body: { error: 'internal' } })
  const client = new CpaClient(BASE, MGMT_KEY, server.fetch)
  assert.deepEqual(await client.apiCall('a1', CLAUDE_USAGE), {
    failed: 'CLIProxyAPI answered HTTP 400 for this account: auth token refresh failed'
  })
  assert.deepEqual(await client.apiCall('b2', CLAUDE_USAGE), { failed: 'CLIProxyAPI answered HTTP 502 for this account: request failed' })
  // Any other status concerns every account.
  await assert.rejects(client.apiCall('c3', CLAUDE_USAGE), failsWith(/HTTP 500: internal/))
})

test('api-call answers without a status are refused; an oversized upstream body fails that account', async () => {
  const call = (body: unknown) => new CpaClient(BASE, MGMT_KEY, fakeFetch({ [CALL_V8]: { status: 200, body } }).fetch).apiCall('a1', CLAUDE_USAGE)
  await assert.rejects(call({ body: '{}' }), failsWith(/without an upstream status/))
  await assert.rejects(call({ status_code: '200', body: '{}' }), failsWith(/without an upstream status/))
  await assert.rejects(call({ status_code: 200, body: { parsed: true } }), failsWith(/not text/))
  assert.deepEqual(await call({ status_code: 200, body: 'x'.repeat(MAX_UPSTREAM_BODY_CHARS + 1) }), {
    failed: `The provider's answer is larger than ${MAX_UPSTREAM_BODY_CHARS} characters.`
  })
  assert.deepEqual(await call({ status_code: 204 }), { status: 204, body: '' })
})

test('an IP ban pauses for the time the server names, or BAN_MS', async () => {
  const banned = (error: string) =>
    new CpaClient(BASE, MGMT_KEY, fakeFetch({ [CREDENTIALS_V8]: { status: 403, body: { error } } }).fetch).listAccounts()
  await assert.rejects(banned('IP banned due to too many failed attempts. Try again in 29m59s'), (error) => {
    assert.ok(error instanceof ClientError)
    assert.deepEqual(error.pause, { kind: 'banned', retryAfterMs: (29 * 60 + 59) * 1000 })
    assert.equal(error.message, 'CLIProxyAPI banned this IP after too many failed logins.')
    return true
  })
  await assert.rejects(banned('IP banned'), (error) => {
    assert.ok(error instanceof ClientError)
    assert.deepEqual(error.pause, { kind: 'banned', retryAfterMs: BAN_MS })
    return true
  })
})

test('a 403 gives the advice that fits the server\'s words', async () => {
  const forbidden = (body: Route) => new CpaClient(BASE, MGMT_KEY, fakeFetch({ [CREDENTIALS_V8]: body }).fetch).listAccounts()
  await assert.rejects(forbidden({ status: 403, body: { error: 'remote management disabled' } }), (error) => {
    assert.ok(error instanceof ClientError)
    assert.equal(error.pause.kind, 'none')
    assert.match(error.message, /remote management disabled.*allow-remote: true/)
    return true
  })
  await assert.rejects(forbidden({ status: 403, body: { error: 'remote management key not set' } }), (error) => {
    assert.ok(error instanceof ClientError)
    assert.match(error.message, /key not set.*management\.secret-key/)
    assert.equal(/allow-remote/.test(error.message), false)
    return true
  })
  await assert.rejects(forbidden({ status: 403, body: { error: 'forbidden by proxy' } }), failsWith(/refused management access \(HTTP 403: forbidden by proxy\)/))
  await assert.rejects(forbidden({ status: 403, raw: 'x'.repeat(5000) }), (error) => error instanceof ClientError && error.message.length < 400)
})

test('the key never appears in a message, even when the server repeats it', async () => {
  const echo = fakeFetch({ [CREDENTIALS_V8]: { status: 500, body: { error: 'bad key secret-123 given, header Bearer other-token' } } })
  await assert.rejects(new CpaClient(BASE, 'secret-123', echo.fetch).listAccounts(), (error) => {
    assert.ok(error instanceof ClientError)
    assert.match(error.message, /bad key \*\*\* given, header Bearer \*\*\*$/)
    return true
  })
})

test('the key is taken out before the message is cut, so no part of it shows across the cut', async () => {
  const key = 'SUPERSECRETKEY-0123456789'
  const fails = async (error: string, used = key) => {
    const fetch: FetchLike = async () => answer(500, JSON.stringify({ error }))
    return new CpaClient(BASE, used, fetch).listAccounts().then(
      () => assert.fail('no error'),
      (thrown: unknown) => (thrown as Error).message
    )
  }
  // The key starts 10 characters before the cut, with and without a space before it.
  for (const words of [`${'x'.repeat(190)} ${key}`, `${'x'.repeat(190)}${key}`]) {
    const text = await fails(words)
    assert.equal(/SUPER|SECRET|0123/.test(text), false, text.slice(-40))
  }
  // Control characters inside the key and after `Bearer` vanish before the search, not after it.
  const hidden = await fails(`Bearer\u0000 ${key.slice(0, 3)}\u0007${key.slice(3)} and ${key.slice(0, 5)}\u0000${key.slice(5)}`)
  assert.equal(/SUPER|SECRET|0123/.test(hidden), false, hidden)
  assert.match(hidden, /Bearer \*\*\* and \*\*\*$/)
  // A key of any length is looked for.
  assert.match(await fails('the key k3y is wrong', 'k3y'), /the key \*\*\* is wrong$/)
})

test('reports an unreachable server without the fetch error\'s own text', async () => {
  const fetch: FetchLike = async () => {
    throw new TypeError('Headers.append: "Bearer abc\u0000def-SECRET" is an invalid header value.')
  }
  await assert.rejects(new CpaClient(BASE, 'abc\u0000def-SECRET', fetch).listAccounts(), (error) => {
    assert.ok(error instanceof ClientError)
    assert.equal(error.message, 'Cannot reach https://x.example.com. Check the URL, and that the server is running.')
    return true
  })
})

test('times out management requests, and api-calls as a slow provider of that account', async () => {
  const client = new CpaClient(BASE, MGMT_KEY, hang, { managementTimeoutMs: 30, apiCallTimeoutMs: 40 })
  await assert.rejects(client.listAccounts(), failsWith(/No answer from https:\/\/x\.example\.com within 0\.03 s/))
  assert.deepEqual(await client.apiCall('a1', CLAUDE_USAGE), { failed: 'No answer within 0.04 s: the provider was too slow.' })
})

test('api-call waits longer than CLIProxyAPI waits for the upstream', () => {
  assert.ok(API_CALL_TIMEOUT_MS >= 65_000)
})

test('passes the caller abort through unchanged', async () => {
  const controller = new AbortController()
  const client = new CpaClient(BASE, MGMT_KEY, hang)
  const listing = client.apiCall('a1', CLAUDE_USAGE, controller.signal)
  const reason = new Error('stopped')
  controller.abort(reason)
  await assert.rejects(listing, (error) => error === reason)
})

test('v0 credential entries read like v8 ones', async () => {
  const client = new CpaClient(BASE, MGMT_KEY, fakeFetch({ [CREDENTIALS_V0]: { status: 200, body: credentialsV0() } }).fetch)
  const { accounts } = await client.listAccounts()
  assert.deepEqual(
    accounts.map((account) => [account.id, account.provider, account.email]),
    [['a1', 'claude', 'me@example.com']]
  )
})
