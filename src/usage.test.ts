import { assert, test } from 'orca/testing'
import {
  allViews,
  compact,
  dayKey,
  emptyStore,
  ingest,
  MAX_NAMES_PER_DAY,
  normalizeRecord,
  OTHER,
  RANGES,
  readStore,
  viewFor
} from './usage'

const NOON = new Date(2026, 10, 9, 12, 0, 0).getTime()
const DAY = 24 * 60 * 60 * 1000
const at = (time: number) => new Date(time).toISOString()

function record(overrides: Record<string, unknown> = {}) {
  return {
    timestamp: at(NOON),
    latency_ms: 1500,
    source: 'a@example.com',
    auth_index: '0',
    tokens: { input_tokens: 100, output_tokens: 20, reasoning_tokens: 5, cached_tokens: 40, total_tokens: 120 },
    failed: false,
    provider: 'claude',
    model: 'claude-opus-5-5',
    alias: 'opus',
    endpoint: 'POST /v1/messages',
    api_key: 'sk-secret',
    response_headers: { 'Retry-After': ['30'] },
    ...overrides
  }
}

test('normalizes a queue record and keeps no secrets', () => {
  const normalized = normalizeRecord(record(), NOON)
  assert.deepEqual(normalized, {
    at: NOON,
    model: 'claude-opus-5-5',
    provider: 'claude',
    account: 'a@example.com',
    failed: false,
    latencyMs: 1500,
    input: 100,
    output: 20,
    reasoning: 5,
    cached: 40,
    total: 120
  })
  assert.equal(JSON.stringify(normalized).includes('sk-secret'), false)
})

test('fills gaps: total from in+out, alias as model, auth index as account, now as time', () => {
  const normalized = normalizeRecord(
    { tokens: { input_tokens: 7, output_tokens: 3 }, alias: 'gpt', auth_index: '4', timestamp: 'nope' },
    42
  )
  assert.equal(normalized?.total, 10)
  assert.equal(normalized?.model, 'gpt')
  assert.equal(normalized?.account, '4')
  assert.equal(normalized?.at, 42)
  assert.equal(normalizeRecord('x', 0), null)
  assert.equal(normalizeRecord([], 0), null)
  assert.equal(normalizeRecord(null, 0), null)
})

test('ignores negative, fractional and non-numeric token counts', () => {
  const normalized = normalizeRecord(
    { tokens: { input_tokens: -5, output_tokens: 2.6, total_tokens: 'many', cached_tokens: Number.NaN } },
    0
  )
  assert.equal(normalized?.input, 0)
  assert.equal(normalized?.output, 3)
  assert.equal(normalized?.total, 3)
  assert.equal(normalized?.cached, 0)
})

test('counts a record stamped in the future as now, in today', () => {
  const store = emptyStore()
  assert.equal(normalizeRecord(record({ timestamp: at(NOON + 3 * DAY) }), NOON)?.at, NOON)
  ingest(store, [record({ timestamp: at(NOON + 13 * 60 * 60 * 1000) })], NOON, 31)
  assert.deepEqual(Object.keys(store.days), [dayKey(NOON)])
  assert.equal(viewFor(store, NOON, 'today').totals.requests, 1)
  assert.equal(store.lastRecordAt, NOON)
})

test('ingest counts per local day, model and account, and says whether the store changed', () => {
  const store = emptyStore()
  const changed = ingest(
    store,
    [
      record(),
      record({ failed: true, source: 'b@example.com' }),
      record({ model: 'gpt-6', provider: 'codex', timestamp: at(NOON - DAY) }),
      'garbage'
    ],
    NOON,
    31
  )
  assert.equal(changed, true)
  const today = store.days[dayKey(NOON)]
  assert.equal(today.models['claude-opus-5-5'].requests, 2)
  assert.equal(today.models['claude-opus-5-5'].failed, 1)
  assert.equal(today.accounts['b@example.com'].requests, 1)
  assert.equal(store.since, NOON, 'since is the poll time, not the oldest record')
  assert.equal(store.lastRecordAt, NOON)
  assert.equal(ingest(store, [], NOON, 31), false, 'nothing counted, nothing dropped')
  assert.equal(ingest(store, ['garbage'], NOON, 31), false)
})

test('ingest splits records at local midnight', () => {
  const midnight = new Date(2026, 10, 9, 0, 0, 0).getTime()
  const store = emptyStore()
  ingest(store, [record({ timestamp: at(midnight - 60_000) }), record({ timestamp: at(midnight + 60_000) })], NOON, 31)
  assert.deepEqual(Object.keys(store.days).sort(), [dayKey(midnight - 60_000), dayKey(midnight)])
  assert.notEqual(dayKey(midnight - 60_000), dayKey(midnight))
  assert.equal(viewFor(store, NOON, 'today').totals.requests, 1)
  assert.equal(viewFor(store, NOON, 'days7').totals.requests, 2)
})

test('ingest drops days past the retention', () => {
  const store = emptyStore()
  ingest(store, [record(), record({ timestamp: at(NOON - 3 * DAY) })], NOON, 31)
  assert.equal(Object.keys(store.days).length, 2)
  assert.equal(ingest(store, [], NOON, 2), true, 'dropping a day changes the store')
  assert.deepEqual(Object.keys(store.days), [dayKey(NOON)])
})

test('server names such as __proto__ and constructor are ordinary keys', () => {
  const store = emptyStore()
  ingest(
    store,
    [
      record({ model: '__proto__', source: 'constructor' }),
      record({ model: 'constructor', source: '__proto__' }),
      record({ model: 'toString', provider: 'hasOwnProperty' })
    ],
    NOON,
    31
  )
  const probe = {} as Record<string, unknown>
  assert.equal(probe.requests, undefined, 'Object.prototype stays clean')
  assert.equal(probe.input, undefined)
  const view = viewFor(store, NOON, 'today')
  assert.equal(view.totals.requests, 3)
  assert.deepEqual(view.models.map((row) => row.key).sort(), ['__proto__', 'constructor', 'toString'])
  assert.deepEqual(
    view.accounts.map((row) => [row.key, row.totals.requests]).sort(),
    [
      ['__proto__', 1],
      ['a@example.com', 1],
      ['constructor', 1]
    ]
  )
  assert.equal(view.models.find((row) => row.key === 'toString')?.provider, 'hasOwnProperty')

  const restored = readStore(JSON.parse(JSON.stringify(store)))
  assert.deepEqual(
    viewFor(restored, NOON, 'today').models.map((row) => row.key).sort(),
    ['__proto__', 'constructor', 'toString']
  )
  assert.equal(({} as Record<string, unknown>).requests, undefined)
})

test(`counts names past ${MAX_NAMES_PER_DAY} per day under ${OTHER}`, () => {
  const store = emptyStore()
  const records = Array.from({ length: MAX_NAMES_PER_DAY + 25 }, (_, index) =>
    record({ model: `model-${index}`, source: `account-${index}` })
  )
  ingest(store, records, NOON, 31)
  const day = store.days[dayKey(NOON)]
  assert.equal(Object.keys(day.models).length, MAX_NAMES_PER_DAY + 1)
  assert.equal(day.models[OTHER].requests, 25)
  assert.equal(day.accounts[OTHER].requests, 25)
  ingest(store, [record({ model: 'model-3' })], NOON, 31)
  assert.equal(day.models['model-3'].requests, 2, 'a name already counted keeps its row')
  assert.equal(viewFor(store, NOON, 'today').totals.requests, MAX_NAMES_PER_DAY + 26)
})

test('label lengths are capped', () => {
  const normalized = normalizeRecord(record({ model: `  ${'m'.repeat(500)}  ` }), NOON)
  assert.equal(normalized?.model.length, 200)
})

test('RANGES views count back local days, today included', () => {
  assert.deepEqual(
    RANGES.map((range) => [range.id, range.days]),
    [
      ['today', 1],
      ['days7', 7],
      ['days30', 30]
    ]
  )
  const store = emptyStore()
  ingest(
    store,
    [
      record(),
      record({ timestamp: at(NOON - 6 * DAY) }),
      record({ timestamp: at(NOON - 7 * DAY) }),
      record({ timestamp: at(NOON - 29 * DAY) }),
      record({ timestamp: at(NOON - 30 * DAY) })
    ],
    NOON,
    366
  )
  const views = allViews(store, NOON)
  assert.deepEqual(Object.keys(views), ['today', 'days7', 'days30'])
  assert.equal(views.today.totals.requests, 1)
  assert.equal(views.days7.totals.requests, 2)
  assert.equal(views.days30.totals.requests, 4)
  assert.deepEqual(
    views.days7.models.map((row) => [row.key, row.provider, row.totals.total]),
    [['claude-opus-5-5', 'claude', 240]]
  )
})

test('views sort by tokens and list at most 50 rows', () => {
  const store = emptyStore()
  ingest(
    store,
    Array.from({ length: 60 }, (_, index) =>
      record({ model: `m${index}`, tokens: { input_tokens: index, output_tokens: 0, total_tokens: index + 1 } })
    ),
    NOON,
    31
  )
  const view = viewFor(store, NOON, 'today')
  assert.equal(view.models.length, 50)
  assert.equal(view.models[0].key, 'm59')
  assert.equal(view.totals.requests, 60)
})

test('readStore keeps valid data and drops anything malformed', () => {
  const store = emptyStore()
  ingest(store, [record()], NOON, 31)
  assert.deepEqual(readStore(JSON.parse(JSON.stringify(store))), store)
  assert.deepEqual(readStore({ version: 2, days: {} }), emptyStore())
  assert.deepEqual(readStore(null), emptyStore())
  assert.deepEqual(readStore('usage'), emptyStore())

  const restored = readStore({
    version: 1,
    since: 'yesterday',
    lastRecordAt: NOON,
    days: {
      'not-a-day': { models: { m: { requests: 1 } } },
      '2026-11-08': 'garbage',
      '2026-11-09': {
        models: { good: { requests: 2, total: -5, input: 'x', latencyMs: 1.4 }, bad: 7 },
        accounts: null,
        providers: { good: 'claude', odd: 3 }
      }
    }
  })
  assert.deepEqual(Object.keys(restored.days), ['2026-11-09'])
  const day = restored.days['2026-11-09']
  assert.deepEqual(Object.keys(day.models), ['good'])
  assert.equal(day.models.good.requests, 2)
  assert.equal(day.models.good.total, 0)
  assert.equal(day.models.good.input, 0)
  assert.equal(day.models.good.latencyMs, 1)
  assert.equal(day.models.good.failed, 0)
  assert.deepEqual(Object.keys(day.accounts), [])
  assert.deepEqual(Object.keys(day.providers), ['good'])
  assert.equal(restored.since, null)
  assert.equal(restored.lastRecordAt, NOON)
  assert.equal(Object.getPrototypeOf(day.models), null, 'restored maps have no prototype')
})

test('formats compact numbers', () => {
  assert.equal(compact(950), '950')
  assert.equal(compact(12_345), '12.3k')
  assert.equal(compact(4_560_000), '4.56M')
  assert.equal(compact(123_456_789), '123M')
  assert.equal(compact(1_200_000_000), '1.2B')
})
