// Runs src/worker.ts's activate(orca) over a mock host, with a stand-in CLIProxyAPI server behind a
// stubbed globalThis.fetch. Nothing here reaches the network.
import { afterEach, assert, type MockHost, mockHost, mountWorker, type TestWorker, test } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import type { UsageState } from './protocol'
import * as main from './worker'

const QUEUE = '/v8/management/observability/usage/queue'
const STATS = '/v8/management/config/observability/usage/usage-statistics-enabled'
const ORIGIN = 'https://cpa.example.com'

type Sent = { origin: string; path: string; key: string }
type Server = {
  queue: unknown[]
  /** Keys the server accepts. */
  keys: Set<string>
  requests: Sent[]
  /** Answers every request with this instead, when set. */
  override?: { status: number; body: unknown }
  /** Holds each request until it resolves, when set. */
  gate?: Promise<void>
}

const realFetch = globalThis.fetch

function serve(server: Server): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const key = (new Headers(init?.headers).get('Authorization') ?? '').replace(/^Bearer /, '')
    server.requests.push({ origin: url.origin, path: url.pathname, key })
    if (server.gate) await server.gate
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    if (server.override) return json(server.override.status, server.override.body)
    if (!server.keys.has(key)) return json(401, { error: 'invalid management key' })
    if (url.pathname === QUEUE) return json(200, server.queue.splice(0, Number(url.searchParams.get('count') ?? '1')))
    if (url.pathname === STATS) return json(200, true)
    return json(404, { error: 'not_found' })
  }) as typeof fetch
}

function server(keys: string[], queue: unknown[] = []): Server {
  const result: Server = { queue, keys: new Set(keys), requests: [] }
  serve(result)
  return result
}

/** The secret as the worker stores it: the key bound to the origin it is for. */
const secret = (key: string, origin = ORIGIN, refused = false) =>
  JSON.stringify(refused ? { origin, key, refused: true } : { origin, key })

/** Mounts the worker and hands back the `orca` object it got, to change settings as Settings does. */
async function mount(host: MockHost): Promise<{ worker: TestWorker; orca: OrcaWorkerApi }> {
  let orca: OrcaWorkerApi | null = null
  const worker = await mountWorker(
    {
      default: (api: OrcaWorkerApi) => {
        orca = api
        return main.default(api)
      },
      deactivate: main.deactivate
    },
    { host }
  )
  assert.ok(orca)
  return { worker, orca }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await tick()
  assert.ok(condition(), `timed out waiting for ${what}`)
}

afterEach(async () => {
  await main.deactivate()
  globalThis.fetch = realFetch
})

const record = (model: string, total: number) => ({
  timestamp: new Date().toISOString(),
  model,
  provider: 'claude',
  source: 'me@example.com',
  tokens: { input_tokens: total - 1, output_tokens: 1, total_tokens: total },
  api_key: 'client-key'
})

const settings = (baseUrl = ORIGIN) => ({ baseUrl, pollSeconds: 300, retentionDays: 31 })

test('counts queue records into storage, the panel state and the status bar, and never leaks the key', async () => {
  const cpa = server(['good-key-123'], [record('opus', 1000), record('opus', 500), record('haiku', 10)])
  const host = mockHost({ settings: settings(`${ORIGIN}/v1`), secrets: { managementKey: secret('good-key-123') } })
  const { worker } = await mount(host)
  const state = (await worker.request('cpa.refresh')) as UsageState

  assert.equal(state.status.kind, 'ok')
  assert.equal(state.status.tone, 'success')
  assert.equal(state.baseUrl, ORIGIN)
  assert.equal(state.apiVersion, 'v8')
  assert.equal(state.statisticsEnabled, true)
  assert.equal(state.hasKey, true)
  assert.equal(state.retentionDays, 31)
  assert.equal(state.views.today.totals.requests, 3)
  assert.equal(state.views.today.totals.total, 1510)
  assert.deepEqual(
    state.views.today.models.map((row) => [row.key, row.totals.requests]),
    [
      ['opus', 2],
      ['haiku', 1]
    ]
  )
  assert.equal(cpa.queue.length, 0)
  assert.ok(cpa.requests.every((request) => request.origin === ORIGIN && request.key === 'good-key-123'))

  const storage = JSON.stringify(host.data().storage)
  assert.equal(storage.includes('client-key'), false, 'client API keys are not stored')
  assert.equal(storage.includes('good-key-123'), false, 'the management key is not in plain storage')
  for (const leak of [JSON.stringify(state), JSON.stringify(worker.posts), worker.logs.join('\n'), JSON.stringify(host.calls)]) {
    assert.equal(leak.includes('good-key-123'), false, 'the key never leaves the worker')
  }

  const bar = host.callsOf('statusBar.update').at(-1) as { text: string; tone: string; tooltip: string }
  assert.equal(bar.text, 'CPA 1.51k')
  assert.equal(bar.tone, 'neutral')
  assert.match(bar.tooltip, /3 requests/)
  assert.ok(worker.posts.some((post) => post.event === 'cpa.changed'))
  assert.match(String(await worker.command('cliproxyapi.summary')), /3 requests \(0 failed\)/)
  assert.match(String(await worker.command('cliproxyapi.refresh')), /Top model: opus/)
  assert.deepEqual(worker.refusals, [])
})

test('reads more than one page of 500 records in a poll', async () => {
  const cpa = server(['good'], Array.from({ length: 1200 }, (_, index) => record(`m${index % 3}`, 10)))
  const host = mockHost({ settings: settings(), secrets: { managementKey: secret('good') } })
  const { worker } = await mount(host)
  const state = (await worker.request('cpa.refresh')) as UsageState
  assert.equal(state.views.today.totals.requests, 1200)
  assert.equal(cpa.queue.length, 0)
  assert.equal(cpa.requests.filter((request) => request.path === QUEUE).length, 3, '500 + 500 + 200')
})

test('keeps counting across worker restarts', async () => {
  const cpa = server(['good'], [record('opus', 100)])
  const host = mockHost({ settings: settings(), secrets: { managementKey: secret('good') } })
  let { worker } = await mount(host)
  await worker.request('cpa.refresh')
  await worker.deactivate()

  cpa.queue.push(record('opus', 50))
  ;({ worker } = await mount(host))
  const state = (await worker.request('cpa.refresh')) as UsageState
  assert.equal(state.views.today.totals.total, 150)
})

test('a refused key is not sent again, not even after a restart, until a key is saved', async () => {
  const cpa = server(['good'], [record('opus', 100)])
  const host = mockHost({ settings: settings(), secrets: { managementKey: secret('wrong') } })
  let { worker, orca } = await mount(host)
  let state = (await worker.request('cpa.refresh')) as UsageState
  assert.equal(state.status.kind, 'auth')
  assert.equal(cpa.requests.length, 1, 'one refused attempt, no fallback to v0 with the same key')
  assert.equal(JSON.parse(String(host.data().secrets.managementKey)).refused, true)
  assert.equal((host.callsOf('statusBar.update').at(-1) as { tone: string }).tone, 'danger')

  await worker.request('cpa.refresh')
  await orca.settings.set('pollSeconds', 120)
  await worker.request('cpa.refresh')
  assert.equal(cpa.requests.length, 1, 'neither a refresh nor a settings change resends it')

  await worker.deactivate()
  ;({ worker, orca } = await mount(host))
  state = (await worker.request('cpa.refresh')) as UsageState
  assert.equal(state.status.kind, 'auth')
  assert.equal(cpa.requests.length, 1, 'nor does a restart')

  state = (await worker.request('cpa.setKey', { key: ' good ' })) as UsageState
  assert.equal(state.status.kind, 'ok')
  assert.equal(host.data().secrets.managementKey, secret('good'))
  assert.equal(state.views.today.totals.requests, 1)
})

test('a key saved during a running poll is used next and not marked refused by the old poll', async () => {
  let release = () => {}
  const cpa = server(['new'], [record('opus', 100)])
  cpa.gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const host = mockHost({ settings: settings(), secrets: { managementKey: secret('old') } })
  const { worker } = await mount(host)
  await until(() => cpa.requests.length === 1, 'the first poll to ask the server')
  assert.equal(cpa.requests[0].key, 'old')

  const saving = worker.request('cpa.setKey', { key: 'new' }) as Promise<UsageState>
  await until(() => host.data().secrets.managementKey === secret('new'), 'the new key to be stored')
  cpa.gate = undefined
  release()
  const state = await saving

  assert.equal(state.status.kind, 'ok')
  assert.equal(state.views.today.totals.requests, 1)
  assert.equal(host.data().secrets.managementKey, secret('new'), 'the late 401 for the old key changed nothing')
  assert.ok(cpa.requests.slice(1).every((request) => request.key === 'new'))
})

test('a key is bound to the origin it was saved for', async () => {
  const cpa = server(['good'], [record('opus', 100)])
  const host = mockHost({ settings: settings(), secrets: { managementKey: secret('good') } })
  const { worker, orca } = await mount(host)
  await worker.request('cpa.refresh')
  const sent = cpa.requests.length

  await orca.settings.set('baseUrl', 'https://other.example.com')
  const lastPost = () => worker.posts.at(-1)?.payload as UsageState | undefined
  await until(() => lastPost()?.status.kind === 'unconfigured', 'the settings change alone to start a poll')
  let state = (await worker.request('cpa.refresh')) as UsageState
  assert.equal(state.status.kind, 'unconfigured')
  assert.equal(state.hasKey, false)
  assert.match(state.status.message ?? '', /stored key is for https:\/\/cpa\.example\.com/)
  assert.equal(cpa.requests.length, sent, 'nothing goes to the other origin')

  await orca.settings.set('baseUrl', 'http://cpa.example.com')
  state = (await worker.request('cpa.refresh')) as UsageState
  assert.equal(state.status.kind, 'unconfigured')
  assert.equal(state.baseUrl, null)
  assert.match(state.status.message ?? '', /must use https/)
  await assert.rejects(worker.request('cpa.setKey', { key: 'good' }), /must use https/)
  assert.equal(cpa.requests.length, sent, 'nothing goes over plain http to a remote host')

  await orca.settings.set('baseUrl', `${ORIGIN}/v1`)
  state = (await worker.request('cpa.refresh')) as UsageState
  assert.equal(state.status.kind, 'ok', 'back on the saved origin, the key is used again')
  assert.ok(cpa.requests.every((request) => request.origin === ORIGIN))
})

test('a secret not in the origin-bound form counts as no key', async () => {
  const cpa = server(['good'])
  const host = mockHost({ settings: settings(), secrets: { managementKey: 'good' } })
  const { worker } = await mount(host)
  const state = (await worker.request('cpa.refresh')) as UsageState
  assert.equal(state.status.kind, 'unconfigured')
  assert.equal(state.hasKey, false)
  assert.equal(cpa.requests.length, 0)
})

test('an IP ban pauses polling', async () => {
  const cpa = server(['good'])
  cpa.override = { status: 403, body: { error: 'IP banned due to too many failed attempts. Try again in 29m59s' } }
  const host = mockHost({ settings: settings(), secrets: { managementKey: secret('good') } })
  const { worker, orca } = await mount(host)
  let state = (await worker.request('cpa.refresh')) as UsageState
  assert.equal(state.status.kind, 'error')
  assert.match(state.status.message ?? '', /banned this IP/)
  const sent = cpa.requests.length

  await worker.request('cpa.refresh')
  await orca.settings.set('pollSeconds', 60)
  state = (await worker.request('cpa.refresh')) as UsageState
  assert.equal(cpa.requests.length, sent, 'no request while the ban lasts')
  assert.match(state.status.message ?? '', /banned this IP/)
  assert.equal(host.data().secrets.managementKey, secret('good'), 'a ban does not mark the key refused')
})

test('asks for setup without a key or URL and never calls the server', async () => {
  const cpa = server([])
  const host = mockHost({ settings: { baseUrl: 'not a url', pollSeconds: 300 } })
  const { worker } = await mount(host)
  let state = (await worker.request('cpa.refresh')) as UsageState
  assert.equal(state.status.kind, 'unconfigured')
  assert.equal(state.hasKey, false)
  assert.equal(state.baseUrl, null)
  assert.equal((host.callsOf('statusBar.update').at(-1) as { text: string }).text, 'CPA: set up')
  await assert.rejects(worker.request('cpa.setKey', { key: 'k' }), /Set the CLIProxyAPI URL/)

  const local = mockHost({ settings: settings('http://127.0.0.1:8317') })
  await worker.deactivate()
  const mounted = await mount(local)
  state = (await mounted.worker.request('cpa.refresh')) as UsageState
  assert.equal(state.status.message, 'Enter the CLIProxyAPI management key in the panel.')
  await assert.rejects(mounted.worker.request('cpa.setKey', { key: '   ' }), /empty/)
  assert.equal(cpa.requests.length, 0)
})

test('reports an unreachable server and recovers', async () => {
  globalThis.fetch = (async () => {
    throw new TypeError('fetch failed')
  }) as typeof fetch
  const host = mockHost({ settings: settings('https://down.example.com'), secrets: { managementKey: secret('good', 'https://down.example.com') } })
  const { worker } = await mount(host)
  let state = (await worker.request('cpa.refresh')) as UsageState
  assert.equal(state.status.kind, 'error')
  assert.match(state.status.message ?? '', /Cannot reach https:\/\/down\.example\.com/)
  assert.equal((host.callsOf('statusBar.update').at(-1) as { tone: string }).tone, 'warning')

  server(['good'], [record('opus', 1)])
  state = (await worker.request('cpa.refresh')) as UsageState
  assert.equal(state.status.kind, 'ok')
  assert.equal(state.views.today.totals.requests, 1)
})

test('clearing the key stops polling', async () => {
  const cpa = server(['good'])
  const host = mockHost({ settings: settings(), secrets: { managementKey: secret('good') } })
  const { worker } = await mount(host)
  await worker.request('cpa.refresh')
  const sent = cpa.requests.length
  const state = (await worker.request('cpa.clearKey')) as UsageState
  assert.equal(state.hasKey, false)
  assert.equal(state.status.kind, 'unconfigured')
  assert.equal(host.data().secrets.managementKey, undefined)
  await worker.request('cpa.refresh')
  assert.equal(cpa.requests.length, sent)
})

test('reset clears the counts', async () => {
  server(['good'], [record('opus', 100)])
  const host = mockHost({ settings: settings(), secrets: { managementKey: secret('good') } })
  const { worker } = await mount(host)
  let state = (await worker.request('cpa.refresh')) as UsageState
  assert.equal(state.views.days30.totals.requests, 1)
  assert.ok(state.trackingSince)
  state = (await worker.request('cpa.reset')) as UsageState
  assert.equal(state.views.days30.totals.requests, 0)
  assert.equal(state.trackingSince, null)
  assert.deepEqual((host.data().storage.usage as { days: object }).days, {})
  assert.equal((worker.posts.at(-1)?.payload as UsageState).views.today.totals.requests, 0)
})
