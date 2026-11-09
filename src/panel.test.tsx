import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import type { UsageState } from './protocol'
import { emptyTotals, type UsageView } from './usage'

const emptyView = (): UsageView => ({ totals: emptyTotals(), models: [], accounts: [] })
const OK = { kind: 'ok', tone: 'success', label: 'connected', message: null } as const

function state(overrides: Partial<UsageState> = {}): UsageState {
  return {
    baseUrl: 'https://cpa.example.com',
    hasKey: true,
    status: OK,
    lastPollAt: Date.now(),
    trackingSince: Date.now() - 3_600_000,
    apiVersion: 'v8',
    statisticsEnabled: true,
    retentionDays: 31,
    views: { today: emptyView(), days7: emptyView(), days30: emptyView() },
    ...overrides
  }
}

function withUsage(overrides: Partial<UsageState> = {}): UsageState {
  const totals = { ...emptyTotals(), requests: 12, failed: 1, input: 9000, output: 1000, cached: 4000, total: 10_000, latencyMs: 24_000 }
  const today: UsageView = {
    totals,
    models: [{ key: 'claude-opus-5-5', provider: 'claude', totals }],
    accounts: [{ key: 'me@example.com', provider: null, totals }]
  }
  return state({ views: { today, days7: today, days30: today }, ...overrides })
}

const RETENTION_HINT = /Only the last \d+ days? (is|are) kept/

test('asks for the management key and sends it to the worker', async () => {
  const keys: string[] = []
  const host = mockHost({
    requests: {
      'cpa.state': state({
        hasKey: false,
        status: { kind: 'unconfigured', tone: 'neutral', label: 'not set up', message: 'Enter the CLIProxyAPI management key in the panel.' }
      }),
      'cpa.setKey': ({ key }) => {
        keys.push(key)
        return withUsage()
      }
    }
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: 'not set up' }))
  assert.equal(view.find({ text: 'Save and connect' })?.disabled, true, 'nothing to save yet')
  assert.equal(view.find({ text: 'Cancel' }), null, 'no key to fall back to')
  await view.type({ label: 'Management key', type: 'Input' }, 'secret-key')
  await view.press({ text: 'Save and connect' })
  assert.deepEqual(keys, ['secret-key'])
  assert.equal(view.find({ label: 'Management key', type: 'Input' }), null, 'the form closes once connected')
  assert.ok(view.find({ label: 'Usage by model' }))
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('shows a worker refusal of the key and keeps the form', async () => {
  const host = mockHost({
    requests: {
      'cpa.state': state({ hasKey: false, status: { kind: 'unconfigured', tone: 'neutral', label: 'not set up', message: null } }),
      'cpa.setKey': () => {
        throw Object.assign(new Error('Set the CLIProxyAPI URL in the plugin settings.'), { code: 'invalid_params' })
      }
    }
  })
  const view = await mount(panel, { host })
  await view.type({ label: 'Management key', type: 'Input' }, 'k', { submit: true })
  assert.ok(view.find({ type: 'Callout', text: /Set the CLIProxyAPI URL/ }))
  assert.ok(view.find({ label: 'Management key', type: 'Input' }))
  await view.unmount()
})

test('shows totals and tables, and follows worker updates', async () => {
  const host = mockHost({ requests: { 'cpa.state': state() } })
  const view = await mount(panel, { host })
  assert.ok(view.find({ label: 'No requests counted yet' }))
  assert.ok(view.find({ text: 'connected' }))

  await view.post('cpa.changed', withUsage())
  assert.equal(view.rowsOf({ label: 'Usage by model' }).join(), 'claude-opus-5-5')
  assert.equal(view.rowsOf({ label: 'Usage by account' }).join(), 'me@example.com')
  assert.ok(view.find({ text: /10k/ }))
  assert.ok(view.find({ text: /claude-opus-5-5 \(claude\)/ }))
  assert.ok(view.find({ text: /2\.0 s/ }), 'average latency')
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})

test('switches ranges', async () => {
  const today = withUsage().views.today
  const host = mockHost({ requests: { 'cpa.state': state({ views: { today: emptyView(), days7: today, days30: today } }) } })
  const view = await mount(panel, { host })
  assert.ok(view.find({ label: 'No requests counted yet' }))
  await view.select({ label: 'Range' }, 'days7')
  assert.equal(view.rowsOf({ label: 'Usage by model' }).join(), 'claude-opus-5-5')
  await view.unmount()
})

test('reset asks for confirmation first', async () => {
  let resets = 0
  const host = mockHost({
    requests: {
      'cpa.state': withUsage(),
      'cpa.reset': () => {
        resets += 1
        return state()
      }
    }
  })
  const view = await mount(panel, { host })
  await view.press({ text: 'Reset counts' })
  assert.equal(resets, 0, 'the first press only asks')
  assert.ok(view.find({ text: 'Confirm reset' }))
  await view.press({ text: 'Cancel' })
  assert.equal(resets, 0)
  assert.equal(view.find({ text: 'Confirm reset' }), null)
  assert.ok(view.find({ label: 'Usage by model' }))

  await view.press({ text: 'Reset counts' })
  await view.press({ text: 'Confirm reset' })
  assert.equal(resets, 1)
  assert.ok(view.find({ label: 'No requests counted yet' }))
  assert.ok(view.find({ text: 'Reset counts' }), 'back to the single button')
  await view.unmount()
})

test('hints that a range longer than the retention shows only what is kept', async () => {
  const host = mockHost({ requests: { 'cpa.state': withUsage({ retentionDays: 7 }) } })
  const view = await mount(panel, { host })
  assert.equal(view.find({ text: RETENTION_HINT }), null)
  await view.select({ label: 'Range' }, 'days7')
  assert.equal(view.find({ text: RETENTION_HINT }), null, 'seven days fit in seven days')
  await view.select({ label: 'Range' }, 'days30')
  assert.ok(view.find({ text: /Only the last 7 days are kept/ }))

  await view.post('cpa.changed', withUsage({ retentionDays: 1 }))
  assert.ok(view.find({ text: /Only the last 1 day is kept/ }))
  await view.unmount()
})

test('shows a refused key as an error with the key form and no way around it', async () => {
  const host = mockHost({
    requests: {
      'cpa.state': state({
        status: { kind: 'auth', tone: 'danger', label: 'key refused', message: 'The server refused the management key.' }
      })
    }
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: 'key refused' }))
  assert.ok(view.find({ label: 'Management key', type: 'Input' }))
  assert.equal(view.find({ text: 'Cancel' }), null, 'Cancel would not bring the refused key back')
  assert.ok(view.summary().some((line) => line.includes('refused')))
  await view.unmount()
})

test('changing the key can be cancelled while the key works', async () => {
  const host = mockHost({ requests: { 'cpa.state': withUsage() } })
  const view = await mount(panel, { host })
  assert.equal(view.find({ label: 'Management key', type: 'Input' }), null)
  await view.press({ text: 'Change key' })
  assert.ok(view.find({ label: 'Management key', type: 'Input' }))
  await view.press({ text: 'Cancel' })
  assert.equal(view.find({ label: 'Management key', type: 'Input' }), null)
  await view.unmount()
})

test('warns when the server does not publish usage', async () => {
  const host = mockHost({ requests: { 'cpa.state': state({ statisticsEnabled: false }) } })
  const view = await mount(panel, { host })
  assert.ok(view.find({ type: 'Callout', text: /does not publish usage/ }))
  await view.unmount()
})

test('says when the worker does not answer', async () => {
  const host = mockHost({ requests: {} })
  const view = await mount(panel, { host })
  assert.ok(view.find({ type: 'Callout', text: /did not answer/ }))
  await view.unmount()
})
