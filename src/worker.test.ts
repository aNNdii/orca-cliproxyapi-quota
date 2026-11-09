// Runs src/worker.ts's activate(orca) over a mock host, with a stand-in CLIProxyAPI server behind a
// stubbed globalThis.fetch and a clock that moves only when a test says so. Nothing here reaches
// the network.
import { afterEach, assert, hostError, type MockHost, mockHost, mountWorker, type TestWorker, test } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import { BAN_MS } from './client'
import { pollDeadlineMs, RATE_LIMIT_REST_MS, REFUSED_REST_MS } from './collector'
import {
  type ApiCall,
  claudeUsage,
  defaultUpstream,
  type FakeClock,
  type FakeServer,
  fakeClock,
  fakeServer,
  KEY,
  ORIGIN,
  PATHS,
  UPSTREAM
} from './fixtures'
import { MESSAGES, STATUS_TEXT_CHARS, TOOLTIP_CHARS } from './format'
import { encodeKey, KEY_SECRET } from './keystore'
import { type QuotaState, STATE_BUDGET_BYTES } from './protocol'
import * as main from './worker'

const realFetch = globalThis.fetch

function serve(server: FakeServer): FakeServer {
  globalThis.fetch = server.fetch as unknown as typeof fetch
  return server
}

/** The secret as the worker stores it: the key bound to the origin it is for. */
const secret = (key: string, origin = ORIGIN, refused = false) => encodeKey({ origin, key, refused })
const storedSecret = (host: MockHost) => host.data().secrets[KEY_SECRET]

type Mounted = { worker: TestWorker; orca: OrcaWorkerApi; clock: FakeClock }

/** Mounts the worker on `clock` and hands back the `orca` object it got, to change settings as Settings does. */
async function mount(host: MockHost, clock = fakeClock()): Promise<Mounted> {
  let orca: OrcaWorkerApi | null = null
  const activate = main.activateWith((url, init) => fetch(url, init), clock)
  const worker = await mountWorker(
    {
      default: (api: OrcaWorkerApi) => {
        orca = api
        return activate(api)
      },
      deactivate: main.deactivate
    },
    { host }
  )
  assert.ok(orca)
  return { worker, orca, clock }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400 && !condition(); i++) await tick()
  assert.ok(condition(), `timed out waiting for ${what}`)
}

afterEach(async () => {
  await main.deactivate()
  globalThis.fetch = realFetch
})

const settings = (baseUrl = ORIGIN, pollSeconds = 300) => ({ baseUrl, pollSeconds })
const withKey = (overrides: Parameters<typeof mockHost>[0] = {}) =>
  mockHost({ settings: settings(), secrets: { [KEY_SECRET]: secret(KEY) }, ...overrides })
const current = (worker: TestWorker) => worker.request('cpa.state') as Promise<QuotaState>
/** A manual refresh as the command runs it, which waits for the poll; then the state. */
async function refresh(worker: TestWorker): Promise<QuotaState> {
  await worker.command('cliproxyapi.refresh')
  return current(worker)
}
/** Lets the poll timer fire, waits for that poll to end, and returns the state. */
async function timerPoll({ worker, clock }: Mounted, ms?: number): Promise<QuotaState> {
  await until(() => clock.pending().length > 0, 'the poll timer')
  const before = worker.posts.length
  clock.advance(ms ?? clock.pending()[0])
  await until(() => worker.posts.length > before, 'the timer poll to end')
  return current(worker)
}
const lastPost = (worker: TestWorker) => worker.posts.at(-1)?.payload as QuotaState | undefined
const account = (state: QuotaState, title: string) => {
  const found = state.accounts.find((entry) => entry.title === title)
  assert.ok(found, `no account ${title}`)
  return found
}
type Bar = { id: string; text: string; tone: string; tooltip: string }
const lastBar = (host: MockHost) => host.callsOf('statusBar.update').at(-1) as Bar
const callsFor = (cpa: FakeServer, authIndex: string, url?: string) =>
  cpa.apiCalls.filter((call) => call.auth_index === authIndex && (url === undefined || call.url === url)).length
const listings = (cpa: FakeServer) => cpa.requests.filter((request) => request.path === PATHS.v8.credentials).length

test('reads the quota of every enabled account, and shows the rest without asking for them', async () => {
  const cpa = serve(fakeServer())
  const host = withKey({ settings: settings(`${ORIGIN}/v1`) })
  const { worker } = await mount(host)
  const state = await refresh(worker)

  assert.equal(state.status.kind, 'ok')
  assert.equal(state.polling, false)
  assert.equal(state.baseUrl, ORIGIN)
  assert.equal(state.apiVersion, 'v8')
  assert.equal(state.pollSeconds, 300)
  assert.deepEqual(
    state.accounts.map((entry) => [entry.provider, entry.title, entry.kind, entry.plan]),
    [
      ['Claude', 'me@example.com', 'quota', 'Max 5x'],
      ['Codex', 'work@example.com', 'quota', 'Plus'],
      ['Antigravity', 'ag@example.com', 'quota', null],
      ['Claude', 'old@example.com', 'disabled', null],
      ['Gemini CLI', 'g@example.com', 'unsupported', null]
    ]
  )
  const claude = account(state, 'me@example.com')
  assert.deepEqual(claude.windows.map((window) => [window.label, window.usedPercent]), [
    ['5h', 62],
    ['7d', 30.5],
    ['7d Sonnet', 12]
  ])
  assert.equal(claude.error, null)
  assert.ok(claude.updatedAt)
  assert.deepEqual(account(state, 'ag@example.com').windows.map((window) => window.usedPercent), [25, 60, 0])

  const asked = cpa.apiCalls.map((call) => call.auth_index)
  assert.equal(asked.includes('d4'), false, 'a disabled account is not queried')
  assert.equal(asked.includes('e5'), false, 'an unsupported account is not queried')
  assert.deepEqual([...new Set(asked)].sort(), ['a1', 'b2', 'c3'])
  assert.equal(cpa.apiCalls.find((call) => call.auth_index === 'b2')?.header['Chatgpt-Account-Id'], 'acct-123')
  assert.ok(cpa.requests.every((request) => request.origin === ORIGIN && request.key === KEY))

  for (const leak of [JSON.stringify(state), JSON.stringify(worker.posts), worker.logs.join('\n'), JSON.stringify(host.calls)]) {
    assert.equal(leak.includes(KEY), false, 'the key never leaves the worker')
    assert.equal(leak.includes('UPSTREAM-BODY-MARKER'), false, 'upstream bodies are never passed on')
    assert.equal(leak.includes('$TOKEN$'), false, 'request headers are never passed on')
  }
  assert.ok(worker.posts.some((post) => post.event === 'cpa.changed'))
  assert.deepEqual(worker.refusals, [])
})

test('the status bar shows the tightest window and lists every account in the tooltip', async () => {
  serve(fakeServer())
  const host = withKey()
  const { worker } = await mount(host)
  await refresh(worker)
  const bar = lastBar(host)
  assert.equal(bar.id, 'quota')
  assert.match(bar.text, /^Claude 5h 62% · \d\d:\d\d$/)
  assert.equal(bar.tone, 'neutral')
  assert.deepEqual(bar.tooltip.split('\n'), [
    'Claude me@example.com: 5h 62%, 7d 31%, 7d Sonnet 12%',
    'Codex work@example.com: 5h 58%, 7d 20%',
    'Antigravity ag@example.com: Gemini 5h 25%, Gemini 7d 60%, Claude 5h 0%',
    'Claude old@example.com: disabled',
    'Gemini CLI g@example.com: quota not available'
  ])

  const lines = String(await worker.command('cliproxyapi.quota')).split('\n')
  assert.equal(lines[0], 'CLIProxyAPI quota')
  assert.match(lines[1], /^Claude me@example\.com \(Max 5x\): 5h 62% · resets .+, 7d 31% · resets .+, 7d Sonnet 12% · resets/)
  assert.match(lines[2], /^Codex work@example\.com \(Plus\): 5h 58% · resets/)
  assert.match(lines[4], /old@example\.com: disabled$/)
  assert.match(lines[5], /^Gemini CLI g@example\.com: quota not available$/)
  assert.match(String(await worker.command('cliproxyapi.refresh')), /Codex work@example\.com/)
})

test('the status bar stays within Orca\'s limits with many accounts', async () => {
  const files = Array.from({ length: 30 }, (_, index) => ({
    auth_index: `i${index}`,
    provider: 'claude',
    email: `someone-with-a-long-address-${index}@example.com`
  }))
  serve(fakeServer({ credentials: { files } }))
  const host = withKey()
  const { worker } = await mount(host)
  await refresh(worker)
  const bar = lastBar(host)
  assert.ok(bar.tooltip.length <= TOOLTIP_CHARS, `${bar.tooltip.length} characters`)
  assert.match(bar.tooltip, /\n\+\d+ more in the panel$/)
  assert.ok(bar.text.length <= STATUS_TEXT_CHARS)
  assert.deepEqual(worker.refusals, [])
  assert.equal(String(await worker.command('cliproxyapi.quota')).split('\n').length, 31)
})

test('status bar tone follows the tightest window: warning from 80 %, danger from 95 % or at the limit', async () => {
  const cpa = serve(fakeServer())
  const host = withKey()
  const { worker } = await mount(host)
  const cases: [number, string, RegExp][] = [
    [79, 'neutral', /^Claude 5h 79%/],
    [80, 'warning', /^Claude 5h 80%/],
    [96, 'danger', /^Claude 5h 96%/],
    [100, 'danger', /^Claude 5h 100%/]
  ]
  for (const [used, tone, text] of cases) {
    cpa.upstream = (call) =>
      call.url === UPSTREAM.claudeUsage ? { status: 200, body: claudeUsage(used) } : { status: 503, body: '' }
    await refresh(worker)
    assert.equal(lastBar(host).tone, tone, `${used} %`)
    assert.match(lastBar(host).text, text)
  }
})

test('after a refused key or a failed poll the status bar shows the status, not the old numbers', async () => {
  const cpa = serve(fakeServer())
  const host = withKey()
  const { worker } = await mount(host)
  await refresh(worker)
  assert.match(lastBar(host).text, /^Claude 5h 62%/)

  cpa.override = { status: 500, body: { error: 'internal' } }
  let state = await refresh(worker)
  assert.equal(state.status.kind, 'error')
  assert.deepEqual([lastBar(host).text, lastBar(host).tone], ['CPA: error', 'warning'])

  cpa.override = undefined
  cpa.keys.clear()
  state = await refresh(worker)
  assert.equal(state.status.kind, 'auth')
  assert.deepEqual([lastBar(host).text, lastBar(host).tone], ['CPA: key refused', 'danger'])
  assert.match(lastBar(host).tooltip, /refused the management key/)
})

test('an upstream 401 is an account error that rests 30 minutes, and Refresh asks anyway', async () => {
  const cpa = serve(fakeServer())
  cpa.upstream = (call) => (call.auth_index === 'b2' ? { status: 401, raw: 'TOKEN-EXPIRED-BODY' } : defaultUpstream(call))
  const host = withKey()
  const mounted = await mount(host)
  let state = await refresh(mounted.worker)
  assert.equal(state.status.kind, 'ok')
  assert.equal(storedSecret(host), secret(KEY), 'the key is not marked refused')
  const codex = account(state, 'work@example.com')
  assert.match(codex.error ?? '', /upstream 401.*Asked again at \d\d:\d\d, or on Refresh\./)
  assert.deepEqual(codex.windows, [])
  assert.equal(account(state, 'me@example.com').error, null, 'other accounts keep working')
  assert.equal(JSON.stringify(state).includes('TOKEN-EXPIRED-BODY'), false)

  const asked = callsFor(cpa, 'b2')
  await timerPoll(mounted)
  assert.equal(callsFor(cpa, 'b2'), asked, 'a timer poll leaves it resting')
  assert.ok(callsFor(cpa, 'a1') > 1, 'the others are read')
  await refresh(mounted.worker)
  assert.equal(callsFor(cpa, 'b2'), asked + 1, 'a manual refresh asks it again')

  cpa.upstream = defaultUpstream
  state = await timerPoll(mounted, REFUSED_REST_MS)
  assert.equal(callsFor(cpa, 'b2'), asked + 2, 'asked again once the rest is over')
  assert.equal(account(state, 'work@example.com').error, null)
})

test('an account keeps its last good windows while later reads fail', async () => {
  const cpa = serve(fakeServer())
  const host = withKey()
  const { worker } = await mount(host)
  const first = account(await refresh(worker), 'me@example.com')
  cpa.apiCallErrors.set('a1', { status: 400, body: { error: 'auth token refresh failed' } })
  const second = account(await refresh(worker), 'me@example.com')
  assert.deepEqual(second.windows, first.windows)
  assert.equal(second.updatedAt, first.updatedAt)
  assert.match(second.error ?? '', /auth token refresh failed/)
  assert.match(lastBar(host).tooltip, /Claude me@example\.com: 5h 62%, 7d 31%, 7d Sonnet 12% \(stale\)/)
  assert.match(String(await worker.command('cliproxyapi.quota')), /last read failed: .*auth token refresh failed/)
})

test('a 429 rests that account for 15 minutes, even on Refresh, and it is asked again after', async () => {
  const cpa = serve(fakeServer())
  cpa.upstream = (call) => (call.auth_index === 'b2' ? { status: 429, body: '' } : defaultUpstream(call))
  const mounted = await mount(withKey())
  let state = await refresh(mounted.worker)
  const until15 = new Date(mounted.clock.now() + RATE_LIMIT_REST_MS)
  const at = `${String(until15.getHours()).padStart(2, '0')}:${String(until15.getMinutes()).padStart(2, '0')}`
  assert.match(account(state, 'work@example.com').error ?? '', new RegExp(`upstream 429\\)\\. Asked again at ${at}\\.$`))
  const before = callsFor(cpa, 'b2')
  state = await refresh(mounted.worker)
  await timerPoll(mounted)
  assert.equal(callsFor(cpa, 'b2'), before, 'not asked while it rests')
  assert.match(account(state, 'work@example.com').error ?? '', /429/)

  cpa.upstream = defaultUpstream
  state = await timerPoll(mounted, RATE_LIMIT_REST_MS)
  assert.equal(callsFor(cpa, 'b2'), before + 1, 'asked again once the rest is over')
  assert.equal(account(state, 'work@example.com').error, null)
})

test('a Claude plan lookup happens once, also when it finds no plan, and its 429 rests the account', async () => {
  const cpa = serve(fakeServer())
  cpa.upstream = (call) => (call.url === UPSTREAM.claudeProfile ? { status: 200, body: { account: {} } } : defaultUpstream(call))
  const mounted = await mount(withKey())
  await refresh(mounted.worker)
  await refresh(mounted.worker)
  const state = await refresh(mounted.worker)
  assert.equal(callsFor(cpa, 'a1', UPSTREAM.claudeProfile), 1)
  assert.ok(callsFor(cpa, 'a1', UPSTREAM.claudeUsage) >= 3)
  assert.equal(account(state, 'me@example.com').plan, null)

  await main.deactivate()
  const limited = serve(fakeServer())
  limited.upstream = (call) => (call.url === UPSTREAM.claudeProfile ? { status: 429, body: '' } : defaultUpstream(call))
  const again = await mount(withKey())
  let view = account(await refresh(again.worker), 'me@example.com')
  assert.equal(view.windows.length, 3, 'the windows still show')
  assert.equal(view.plan, null)
  await refresh(again.worker)
  await timerPoll(again)
  assert.equal(callsFor(limited, 'a1', UPSTREAM.claudeUsage), 1, 'the account rests')
  limited.upstream = defaultUpstream
  view = account(await timerPoll(again, RATE_LIMIT_REST_MS), 'me@example.com')
  assert.equal(callsFor(limited, 'a1', UPSTREAM.claudeProfile), 2, 'the plan is asked for again after the rest')
  assert.equal(view.plan, 'Max 5x')
})

test('the poll timer fires, and a settings change replaces it', async () => {
  const cpa = serve(fakeServer())
  const mounted = await mount(withKey())
  const { clock, orca, worker } = mounted
  await until(() => worker.posts.length > 0 && clock.pending().length === 1, 'the first poll to schedule the next')
  assert.deepEqual(clock.pending(), [300_000])
  const first = listings(cpa)
  await timerPoll(mounted)
  assert.equal(listings(cpa), first + 1, 'the timer polled')

  const posted = worker.posts.length
  await orca.settings.set('pollSeconds', 120)
  await until(
    () => worker.posts.length > posted && clock.pending().length === 1 && clock.pending()[0] === 120_000,
    'the settings poll and its new timer'
  )
  assert.equal(listings(cpa), first + 2, 'the settings change polled')
  assert.deepEqual(clock.pending(), [120_000], 'the old timer is gone')
  await timerPoll(mounted, 120_000)
  assert.equal(listings(cpa), first + 3)
  assert.deepEqual(clock.pending(), [120_000])
})

test('a poll that takes too long is stopped at its deadline', async () => {
  const cpa = serve(fakeServer())
  cpa.gate = new Promise<void>(() => {})
  const { worker, clock } = await mount(withKey())
  await until(() => cpa.requests.length === 1 && clock.pending().length === 1, 'the poll to wait on the server')
  const deadline = pollDeadlineMs(300)
  assert.deepEqual(clock.pending(), [deadline])
  clock.advance(deadline)
  await until(() => lastPost(worker)?.status.kind === 'error', 'the poll to stop')
  assert.equal(lastPost(worker)?.status.message, MESSAGES.pollTooSlow(deadline))
  assert.equal(lastPost(worker)?.polling, false)
})

test('reads at most three accounts at a time', async () => {
  const files = Array.from({ length: 8 }, (_, index) => ({ auth_index: `i${index}`, provider: 'claude', email: `u${index}@x` }))
  const cpa = serve(fakeServer({ credentials: { files } }))
  cpa.delayMs = 5
  const { worker } = await mount(withKey())
  const state = await refresh(worker)
  assert.equal(state.accounts.length, 8)
  assert.ok(state.accounts.every((entry) => entry.windows.length === 3))
  assert.equal(cpa.maxInFlight, 3)
})

test('one poll at a time: refreshes during a timer poll share one manual poll after it, and the panel\'s Refresh answers at once', async () => {
  let release = () => {}
  const cpa = serve(fakeServer())
  cpa.gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const { worker } = await mount(withKey())
  await until(() => cpa.requests.length === 1, 'the first poll to ask the server')
  const panel = (await worker.request('cpa.refresh')) as QuotaState
  assert.equal(panel.polling, true, 'the panel hears of the result through cpa.changed')
  const a = worker.command('cliproxyapi.refresh')
  const b = worker.command('cliproxyapi.refresh')
  cpa.gate = undefined
  release()
  await Promise.all([a, b])
  assert.equal(listings(cpa), 2, 'the start poll, then one manual poll for all three callers')
  assert.equal(lastPost(worker)?.polling, false)

  const before = listings(cpa)
  const c = worker.command('cliproxyapi.refresh')
  const d = worker.command('cliproxyapi.refresh')
  await Promise.all([c, d])
  assert.equal(listings(cpa), before + 1, 'refreshes during a manual poll share it')
})

test('a refused management key is not sent again, not even after a restart, until a key is saved', async () => {
  const cpa = serve(fakeServer({ keys: ['good'] }))
  const host = mockHost({ settings: settings(), secrets: { [KEY_SECRET]: secret('wrong') } })
  let { worker, orca } = await mount(host)
  let state = await refresh(worker)
  assert.equal(state.status.kind, 'auth')
  assert.equal(cpa.requests.length, 1, 'one refused attempt, no fallback to v0 with the same key')
  assert.equal(JSON.parse(String(storedSecret(host))).refused, true)
  assert.equal(lastBar(host).text, 'CPA: key refused')

  await refresh(worker)
  await orca.settings.set('pollSeconds', 120)
  await refresh(worker)
  assert.equal(cpa.requests.length, 1, 'neither a refresh nor a settings change resends it')

  await worker.deactivate()
  ;({ worker, orca } = await mount(host))
  state = await refresh(worker)
  assert.equal(state.status.kind, 'auth')
  assert.equal(cpa.requests.length, 1, 'nor does a restart')

  state = (await worker.request('cpa.setKey', { key: ' good ' })) as QuotaState
  assert.equal(state.status.kind, 'connecting')
  assert.equal(state.hasKey, true)
  assert.equal(storedSecret(host), secret('good'))
  await until(() => lastPost(worker)?.status.kind === 'ok', 'the poll with the new key')
  assert.equal(lastPost(worker)?.accounts.length, 5)
})

test('a refusal that cannot be stored still stops the key from being sent again', async () => {
  const cpa = serve(fakeServer({ keys: ['good'] }))
  const host = mockHost({
    settings: settings(),
    secrets: { [KEY_SECRET]: secret('wrong') },
    results: {
      'secrets.set': () => {
        throw hostError('action_failed', 'the keychain is locked')
      }
    }
  })
  const { worker, orca } = await mount(host)
  let state = await refresh(worker)
  assert.equal(state.status.kind, 'auth')
  assert.ok(worker.logs.some((line) => /could not store that the key was refused/.test(line)))
  await refresh(worker)
  await orca.settings.set('pollSeconds', 120)
  state = await refresh(worker)
  assert.equal(state.status.kind, 'auth')
  await orca.settings.set('baseUrl', 'https://other.example.com')
  await refresh(worker)
  await orca.settings.set('baseUrl', ORIGIN)
  state = await refresh(worker)
  assert.equal(state.status.kind, 'auth', 'not even a URL change and back resends it')
  assert.equal(cpa.requests.length, 1)
})

test('a management 401 during the account reads stops the poll and marks the key refused', async () => {
  const cpa = serve(fakeServer())
  const realFetchOf = cpa.fetch
  cpa.fetch = async (url, init) => {
    // The key works for the list but is revoked before the api-calls.
    if (url.endsWith(PATHS.v8.apiCall)) cpa.keys.clear()
    return realFetchOf(url, init)
  }
  serve(cpa)
  const host = withKey()
  const { worker } = await mount(host)
  const state = await refresh(worker)
  assert.equal(state.status.kind, 'auth')
  assert.equal(JSON.parse(String(storedSecret(host))).refused, true)
  assert.ok(cpa.requests.filter((request) => request.path === PATHS.v8.apiCall).length <= 3, 'no reads start after the refusal')
})

test('saving a key answers at once; the old poll is stopped and does not mark the new key refused', async () => {
  let release = () => {}
  const cpa = serve(fakeServer({ keys: ['new'] }))
  cpa.gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const host = mockHost({ settings: settings(), secrets: { [KEY_SECRET]: secret('old') } })
  const { worker } = await mount(host)
  await until(() => cpa.requests.length === 1, 'the first poll to ask the server')
  assert.equal(cpa.requests[0].key, 'old')

  const state = (await worker.request('cpa.setKey', { key: 'new' })) as QuotaState
  assert.equal(state.status.kind, 'connecting', 'answered while the server still holds the old poll')
  assert.equal(storedSecret(host), secret('new'))
  cpa.gate = undefined
  release()
  await until(() => lastPost(worker)?.status.kind === 'ok', 'the poll with the new key')

  assert.equal(lastPost(worker)?.accounts.length, 5)
  assert.equal(storedSecret(host), secret('new'), 'the old poll changed nothing')
  assert.ok(cpa.requests.slice(1).every((request) => request.key === 'new'))
})

test('a poll overtaken by a key change sets nothing', async () => {
  let release = () => {}
  const cpa = serve(fakeServer())
  const host = withKey()
  const { worker } = await mount(host)
  await refresh(worker)
  cpa.gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const sent = cpa.requests.length
  const polling = worker.command('cliproxyapi.refresh')
  await until(() => cpa.requests.length === sent + 1, 'the poll to ask the server')
  const posted = worker.posts.length
  const cleared = (await worker.request('cpa.clearKey')) as QuotaState
  assert.equal(cleared.status.kind, 'unconfigured')
  cpa.gate = undefined
  release()
  await polling
  const state = await current(worker)
  assert.equal(state.status.kind, 'unconfigured')
  assert.deepEqual(state.accounts, [])
  assert.equal(state.omitted, 0)
  assert.equal(cpa.requests.length, sent + 1, 'the overtaken poll sends nothing more')
  const later = worker.posts.slice(posted).map((post) => post.payload as QuotaState)
  assert.ok(later.length > 0)
  assert.ok(later.every((entry) => entry.status.kind !== 'ok' && entry.accounts.length === 0), JSON.stringify(later.map((entry) => entry.status)))
})

test('a key is bound to the origin it was saved for', async () => {
  const cpa = serve(fakeServer())
  const host = withKey()
  const { worker, orca } = await mount(host)
  await refresh(worker)
  const sent = cpa.requests.length

  await orca.settings.set('baseUrl', 'https://other.example.com')
  await until(() => lastPost(worker)?.status.kind === 'unconfigured', 'the settings change alone to start a poll')
  let state = await refresh(worker)
  assert.equal(state.status.kind, 'unconfigured')
  assert.equal(state.hasKey, false)
  assert.match(state.status.message ?? '', /stored key is for https:\/\/cpa\.example\.com/)
  assert.equal(cpa.requests.length, sent, 'nothing goes to the other origin')
  assert.deepEqual([state.accounts.length, state.lastPollAt], [0, null], 'nor shows what the old one read')

  await orca.settings.set('baseUrl', 'http://cpa.example.com')
  state = await refresh(worker)
  assert.equal(state.status.kind, 'unconfigured')
  assert.equal(state.baseUrl, null)
  assert.match(state.status.message ?? '', /must use https/)
  await assert.rejects(worker.request('cpa.setKey', { key: KEY }), /must use https/)
  assert.equal(cpa.requests.length, sent, 'nothing goes over plain http to a remote host')

  await orca.settings.set('baseUrl', `${ORIGIN}/v1`)
  state = await refresh(worker)
  assert.equal(state.status.kind, 'ok', 'back on the saved origin, the key is used again')
  assert.ok(cpa.requests.every((request) => request.origin === ORIGIN))
})

test('a secret not in the origin-bound form counts as no key', async () => {
  const cpa = serve(fakeServer())
  const { worker } = await mount(mockHost({ settings: settings(), secrets: { [KEY_SECRET]: KEY } }))
  const state = await refresh(worker)
  assert.equal(state.status.kind, 'unconfigured')
  assert.equal(state.hasKey, false)
  assert.equal(cpa.requests.length, 0)
})

test('an IP ban pauses polling until it ends', async () => {
  const cpa = serve(fakeServer())
  cpa.override = { status: 403, body: { error: 'IP banned due to too many failed attempts. Try again in 29m59s' } }
  const host = withKey()
  const mounted = await mount(host)
  const { worker, orca } = mounted
  let state = await refresh(worker)
  assert.equal(state.status.kind, 'error')
  assert.match(state.status.message ?? '', /banned this IP/)
  const sent = cpa.requests.length

  cpa.override = undefined
  await refresh(worker)
  await orca.settings.set('pollSeconds', 60)
  state = await refresh(worker)
  assert.equal(cpa.requests.length, sent, 'no request while the ban lasts')
  assert.match(state.status.message ?? '', /banned this IP/)
  assert.equal(storedSecret(host), secret(KEY), 'a ban does not mark the key refused')

  state = await timerPoll(mounted, BAN_MS)
  assert.ok(cpa.requests.length > sent, 'polling resumes after the ban')
  assert.equal(state.status.kind, 'ok')
})

test('asks for setup without a key or URL and never calls the server', async () => {
  const cpa = serve(fakeServer())
  const host = mockHost({ settings: { baseUrl: 'not a url', pollSeconds: 300 } })
  const { worker } = await mount(host)
  let state = await refresh(worker)
  assert.equal(state.status.kind, 'unconfigured')
  assert.equal(state.hasKey, false)
  assert.equal(state.baseUrl, null)
  assert.equal(lastBar(host).text, 'CPA: set up')
  await assert.rejects(worker.request('cpa.setKey', { key: 'k' }), /Set the CLIProxyAPI URL/)

  await worker.deactivate()
  const mounted = await mount(mockHost({ settings: settings('http://127.0.0.1:8317') }))
  state = await refresh(mounted.worker)
  assert.equal(state.status.message, MESSAGES.enterKey)
  await assert.rejects(mounted.worker.request('cpa.setKey', { key: '   ' }), /empty/)
  assert.equal(cpa.requests.length, 0)
})

test('only printable ASCII keys without spaces are saved', async () => {
  serve(fakeServer())
  const host = mockHost({ settings: settings() })
  const { worker } = await mount(host)
  for (const key of ['abc\u0000def', 'two words', 'line\r\nbreak', 'umlaut-ä', 'x'.repeat(513)]) {
    await assert.rejects(worker.request('cpa.setKey', { key }), /printable ASCII/)
  }
  assert.equal(storedSecret(host), undefined)
})

test('reports an unreachable server without the fetch error\'s text, and recovers', async () => {
  globalThis.fetch = (async () => {
    throw new TypeError(`fetch failed: Bearer ${KEY}`)
  }) as typeof fetch
  const down = 'https://down.example.com'
  const host = mockHost({ settings: settings(down), secrets: { [KEY_SECRET]: secret(KEY, down) } })
  const { worker } = await mount(host)
  let state = await refresh(worker)
  assert.equal(state.status.kind, 'error')
  assert.equal(state.status.message, 'Cannot reach https://down.example.com. Check the URL, and that the server is running.')
  assert.deepEqual([lastBar(host).text, lastBar(host).tone], ['CPA: error', 'warning'])
  assert.equal([worker.logs.join('\n'), JSON.stringify(worker.posts), JSON.stringify(host.calls)].join().includes(KEY), false)

  serve(fakeServer())
  state = await refresh(worker)
  assert.equal(state.status.kind, 'ok')
  assert.equal(state.accounts.length, 5)
})

test('forgetting the key stops polling and forgets the accounts', async () => {
  const cpa = serve(fakeServer())
  const host = withKey()
  const { worker } = await mount(host)
  await refresh(worker)
  const sent = cpa.requests.length
  const state = (await worker.request('cpa.clearKey')) as QuotaState
  assert.equal(state.hasKey, false)
  assert.equal(state.status.kind, 'unconfigured')
  assert.deepEqual(state.accounts, [])
  assert.equal(storedSecret(host), undefined)
  await refresh(worker)
  assert.equal(cpa.requests.length, sent)
})

test('the poll interval is clamped to 60..3600 seconds', async () => {
  serve(fakeServer())
  const host = withKey({ settings: { baseUrl: ORIGIN, pollSeconds: 5 } })
  const { worker, orca } = await mount(host)
  assert.equal((await refresh(worker)).pollSeconds, 60)
  await orca.settings.set('pollSeconds', 99_999)
  assert.equal((await refresh(worker)).pollSeconds, 3600)
})

/** Holds the api-calls `held` picks until `release()`; afterwards, and for the others, the server answers at once. */
function holdApiCalls(cpa: FakeServer, held: (call: ApiCall) => boolean) {
  const inner = cpa.fetch
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let waiting = 0
  cpa.fetch = async (url, init) => {
    if (new URL(url).pathname === PATHS.v8.apiCall && held(JSON.parse(init.body ?? '{}') as ApiCall)) {
      waiting += 1
      await gate
    }
    return inner(url, init)
  }
  serve(cpa)
  return { release: () => release(), waiting: () => waiting }
}
const ticks = async (count: number) => {
  for (let i = 0; i < count; i++) await tick()
}

test('a slow account does not fail the poll, even at a 60 s interval', async () => {
  const cpa = serve(fakeServer())
  const held = holdApiCalls(cpa, (call) => call.auth_index === 'b2')
  const { worker, clock } = await mount(withKey({ settings: settings(ORIGIN, 60) }))
  await until(() => held.waiting() === 1 && callsFor(cpa, 'a1') === 2 && callsFor(cpa, 'c3') === 1, 'a1 and c3 to be read while b2 waits')
  assert.ok(pollDeadlineMs(60) > 60_000, 'the deadline leaves time for the slowest read')
  clock.advance(60_000)
  await ticks(20)
  assert.equal(worker.posts.length, 0, 'still waiting for b2: a read in flight is not cut short')
  clock.advance(pollDeadlineMs(60) - 60_000)
  await ticks(20)
  assert.equal(worker.posts.length, 0, 'the deadline only stops new reads')
  held.release()
  await until(() => worker.posts.length > 0, 'the poll to end')
  const state = await current(worker)
  assert.equal(state.status.kind, 'ok')
  assert.deepEqual(
    state.accounts.filter((entry) => entry.kind === 'quota').map((entry) => [entry.title, entry.windows.length, entry.missed]),
    [
      ['me@example.com', 3, false],
      ['work@example.com', 2, false],
      ['ag@example.com', 3, false]
    ]
  )
})

test('at the deadline no new read starts: what was read shows, the rest keep their numbers and go first next time', async () => {
  const files = Array.from({ length: 5 }, (_, index) => ({ auth_index: `i${index}`, provider: 'claude', email: `u${index}@x` }))
  const cpa = serve(fakeServer({ credentials: { files } }))
  const host = withKey()
  const mounted = await mount(host)
  await until(() => mounted.worker.posts.length > 0, 'the first poll')
  assert.ok((await current(mounted.worker)).accounts.every((entry) => entry.windows[0]?.usedPercent === 62))

  const held = holdApiCalls(cpa, () => true)
  const posted = mounted.worker.posts.length
  await until(() => mounted.clock.pending().length > 0, 'the poll timer')
  mounted.clock.advance(mounted.clock.pending()[0])
  await until(() => held.waiting() === 3, 'three reads in flight')
  mounted.clock.advance(pollDeadlineMs(300))
  cpa.upstream = (call) => (call.url === UPSTREAM.claudeUsage ? { status: 200, body: claudeUsage(90) } : defaultUpstream(call))
  held.release()
  await until(() => mounted.worker.posts.length > posted, 'the poll to end')
  let state = await current(mounted.worker)
  assert.equal(state.status.kind, 'ok')
  assert.deepEqual(
    state.accounts.map((entry) => [entry.title, entry.windows[0]?.usedPercent, entry.missed]),
    [
      ['u0@x', 90, false],
      ['u1@x', 90, false],
      ['u2@x', 90, false],
      ['u3@x', 62, true],
      ['u4@x', 62, true]
    ]
  )
  assert.match(lastBar(host).tooltip, /Claude u3@x: 5h 62%, 7d 31%, 7d Sonnet 12% \(not read this poll\)/)

  const start = cpa.apiCalls.length
  state = await timerPoll(mounted)
  assert.deepEqual(cpa.apiCalls.slice(start, start + 2).map((call) => call.auth_index), ['i3', 'i4'], 'the missed go first')
  assert.ok(state.accounts.every((entry) => entry.windows[0]?.usedPercent === 90 && !entry.missed))
})

test('rests learnt in a poll that fails as a whole are kept', async () => {
  const cpa = serve(fakeServer())
  cpa.upstream = (call) => (call.auth_index === 'a1' ? { status: 429, raw: '' } : defaultUpstream(call))
  const inner = cpa.fetch
  cpa.fetch = async (url, init) => {
    // c3's api-call fails for every account, but only after a1 got its 429.
    if (new URL(url).pathname === PATHS.v8.apiCall && (JSON.parse(init.body ?? '{}') as ApiCall).auth_index === 'c3') {
      await until(() => callsFor(cpa, 'a1') > 0, 'a1 to be asked')
      await ticks(10)
      return new Response(JSON.stringify({ error: 'internal' }), { status: 500 })
    }
    return inner(url, init)
  }
  serve(cpa)
  const { worker } = await mount(withKey())
  await until(() => lastPost(worker)?.status.kind === 'error', 'the poll to fail')
  let state = await current(worker)
  assert.match(state.status.message ?? '', /HTTP 500: internal/)
  assert.match(account(state, 'me@example.com').error ?? '', /upstream 429\)\. Asked again at/)
  assert.equal(account(state, 'ag@example.com').missed, true)
  const asked = callsFor(cpa, 'a1')

  cpa.fetch = inner
  serve(cpa)
  state = await refresh(worker)
  assert.equal(state.status.kind, 'ok')
  assert.equal(callsFor(cpa, 'a1'), asked, 'the rest learnt in the failed poll holds')
  assert.equal(account(state, 'ag@example.com').missed, false)
})

test('Refresh during a timer poll asks accounts resting after a 401 in a manual poll after it', async () => {
  const cpa = serve(fakeServer())
  cpa.upstream = (call) => (call.auth_index === 'b2' ? { status: 401, raw: '' } : defaultUpstream(call))
  const mounted = await mount(withKey())
  await until(() => mounted.worker.posts.length > 0, 'the first poll')
  const asked = callsFor(cpa, 'b2')
  const held = holdApiCalls(cpa, () => true)
  await until(() => mounted.clock.pending().length > 0, 'the poll timer')
  mounted.clock.advance(mounted.clock.pending()[0])
  await until(() => held.waiting() > 0, 'the timer poll to read')
  const command = mounted.worker.command('cliproxyapi.refresh')
  await mounted.worker.request('cpa.refresh')
  held.release()
  await command
  assert.equal(callsFor(cpa, 'b2'), asked + 1, 'the manual poll asked it')
  assert.equal(listings(cpa), 3, 'the start poll, the timer poll and one manual poll')
})

test('a published state stays within the post budget, even for a hostile listing', async () => {
  const files = Array.from({ length: 100 }, (_, index) => ({
    auth_index: `${index}-${'i'.repeat(120)}`,
    provider: 'antigravity',
    project_id: 'p',
    email: `${index}${'日'.repeat(199)}`
  }))
  const cpa = serve(fakeServer({ credentials: { files } }))
  cpa.upstream = () => ({
    status: 200,
    body: {
      groups: [
        {
          displayName: '群'.repeat(40),
          buckets: Array.from({ length: 12 }, (_, index) => ({
            displayName: `${index}${'桶'.repeat(39)}`,
            remainingFraction: 0.5,
            resetTime: '2026-11-10T00:00:00Z'
          }))
        }
      ]
    }
  })
  const host = withKey()
  const { worker } = await mount(host)
  await until(() => worker.posts.length > 0, 'the first poll')
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length
  const posted = lastPost(worker)
  assert.ok(posted)
  assert.ok(bytes(posted) <= STATE_BUDGET_BYTES, `${bytes(posted)} bytes`)
  assert.ok(bytes(await current(worker)) <= STATE_BUDGET_BYTES, 'the request answer too')
  assert.equal(posted.accounts.length + posted.omitted, 100, 'every account is shown or counted')
  assert.ok(posted.accounts.length > 0)
  assert.ok(posted.accounts.every((entry) => entry.windows.length === 12 && new Set(entry.windows.map((window) => window.label)).size === 12))
  assert.ok(lastBar(host).tooltip.length <= TOOLTIP_CHARS)
  assert.deepEqual(worker.refusals, [])
})

test('after a new key nothing read with the old one shows, not even when it was last polled', async () => {
  let release = () => {}
  const cpa = serve(fakeServer({ keys: [KEY, 'other-key'] }))
  const host = withKey()
  const { worker } = await mount(host)
  await until(() => worker.posts.length > 0, 'the first poll')
  assert.ok((await current(worker)).lastPollAt)
  cpa.gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const state = (await worker.request('cpa.setKey', { key: 'other-key' })) as QuotaState
  assert.deepEqual([state.status.kind, state.lastPollAt, state.accounts.length], ['connecting', null, 0])
  await until(() => lastBar(host).text === 'CPA: connecting', 'the status bar')
  assert.equal(lastBar(host).tooltip, 'CLIProxyAPI quota: not read yet.')
  cpa.gate = undefined
  release()
  await until(() => lastPost(worker)?.status.kind === 'ok', 'the poll with the new key')
  assert.ok(lastPost(worker)?.lastPollAt)
})
