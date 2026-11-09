import { assert, mockHost, mount, test } from 'orca/testing'
import { sampleState } from './fixtures'
import { MESSAGES } from './format'
import * as panel from './panel'
import type { QuotaState } from './protocol'

/** The sample state with no accounts. */
const state = (overrides: Partial<QuotaState> = {}) => sampleState(Date.now(), { accounts: [], ...overrides })
const withAccounts = (overrides: Partial<QuotaState> = {}) => sampleState(Date.now(), overrides)
const unconfigured = (message: string | null = MESSAGES.enterKey) =>
  state({ hasKey: false, status: { kind: 'unconfigured', message } })

test('asks for the management key and sends it to the worker', async () => {
  const keys: string[] = []
  const host = mockHost({
    requests: {
      'cpa.state': unconfigured(),
      'cpa.setKey': ({ key }) => {
        keys.push(key)
        return withAccounts()
      }
    }
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ type: 'Badge', text: 'not set up' }))
  assert.ok(view.find({ type: 'Callout', text: MESSAGES.enterKey }))
  assert.equal(view.find({ text: 'Save and connect' })?.disabled, true, 'nothing to save yet')
  assert.equal(view.find({ text: 'Cancel' }), null, 'no key to fall back to')
  await view.type({ label: 'Management key', type: 'Input' }, 'secret-key')
  await view.press({ text: 'Save and connect' })
  assert.deepEqual(keys, ['secret-key'])
  assert.equal(view.find({ label: 'Management key', type: 'Input' }), null, 'the form closes once connected')
  assert.ok(view.find({ type: 'Progress', label: /me@example\.com 5h/ }))
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('shows a worker refusal of the key and keeps the form', async () => {
  const host = mockHost({
    requests: {
      'cpa.state': unconfigured(null),
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

test('shows every account with a bar, percent used and reset per window', async () => {
  const host = mockHost({ requests: { 'cpa.state': withAccounts() } })
  const view = await mount(panel, { host })

  assert.ok(view.find({ type: 'Badge', text: 'connected' }))
  assert.ok(view.find({ text: 'Claude · me@example.com' }))
  assert.ok(view.find({ type: 'Badge', text: 'Max 5x' }))
  const fiveHour = view.find({ type: 'Progress', label: 'Claude me@example.com 5h used' })
  assert.equal(fiveHour?.props.value, 62)
  assert.equal(view.find({ type: 'Progress', label: 'Claude me@example.com 7d used' })?.props.value, 85)
  assert.ok(view.find({ type: 'Text', text: '62% used' }))
  assert.equal(view.find({ type: 'Text', text: '85% used' })?.props.tone, 'warning')
  // Every window with a reset time says it: three of me@, one of work@ and one of team@.
  assert.equal(view.findAll({ type: 'Text', text: /^resets / }).length, 5)
  assert.ok(view.find({ text: /^resets \d\d:\d\d$|^resets \w{3} \d\d:\d\d$/ }))
  assert.ok(view.find({ text: 'Extra usage: 5% of the monthly limit used.' }))
  assert.ok(view.find({ text: /^Updated / }))
  assert.equal(view.findAll({ type: 'Text', text: /^Last read failed/ }).length, 1, 'only the failing account shows an error')

  assert.equal(view.find({ type: 'Text', text: '100% used · limit reached' })?.props.tone, 'danger')
  assert.ok(view.find({ type: 'Text', text: /^Last read failed: Codex rejected the account's token \(upstream 401\)/ }))
  assert.ok(view.find({ type: 'Text', text: 'Antigravity answered upstream HTTP 500.' }), 'an error without old windows')
  assert.ok(view.find({ text: 'No successful read yet' }))
  assert.equal(view.findAll({ type: 'Text', text: /^Not read this poll/ }).length, 1, 'only the missed account says so')
  assert.ok(view.find({ type: 'Progress', label: 'Claude team@example.com 5h used' }), 'and keeps its windows')

  assert.ok(view.find({ type: 'Badge', text: 'disabled' }))
  assert.ok(view.find({ text: 'Disabled in CLIProxyAPI; its quota is not read.' }))
  assert.equal(view.find({ type: 'Progress', label: /old@example\.com/ }), null)
  assert.ok(view.find({ text: 'Quota not available for Gemini CLI accounts.' }))
  assert.equal(view.findAll({ type: 'Box' }).filter((box) => box.props.background === 'muted').length, 2, 'disabled and unsupported are greyed')
  assert.ok(view.find({ text: /^Last poll .* · every 5 min$/ }))
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})

test('follows worker updates and refreshes on request', async () => {
  let refreshes = 0
  const host = mockHost({
    requests: {
      'cpa.state': state(),
      'cpa.refresh': () => {
        refreshes += 1
        return withAccounts({ omitted: 2 })
      }
    }
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ label: 'No accounts' }))
  assert.ok(view.find({ text: 'connected' }))

  await view.post('cpa.changed', withAccounts())
  assert.ok(view.find({ type: 'Progress', label: /work@example\.com 5h/ }))

  await view.press({ text: 'Refresh' })
  assert.equal(refreshes, 1)
  assert.ok(view.find({ text: '2 more accounts are not shown.' }))
  await view.unmount()
})

test('shows a refused key as an error with the key form and no way around it', async () => {
  const host = mockHost({ requests: { 'cpa.state': withAccounts({ status: { kind: 'auth', message: MESSAGES.keyRefused } }) } })
  const view = await mount(panel, { host })
  assert.ok(view.find({ type: 'Badge', text: 'key refused' }))
  assert.equal(view.find({ type: 'Callout', text: /refused the management key/ })?.props.tone, 'danger')
  assert.ok(view.find({ label: 'Management key', type: 'Input' }))
  assert.equal(view.find({ text: 'Cancel' }), null, 'Cancel would not bring the refused key back')
  assert.ok(view.summary().some((line) => line.includes('refused')))
  await view.unmount()
})

test('Forget key deletes the key through the worker, and the form comes back', async () => {
  let cleared = 0
  const host = mockHost({
    requests: {
      'cpa.state': withAccounts(),
      'cpa.clearKey': () => {
        cleared += 1
        return unconfigured()
      }
    }
  })
  const view = await mount(panel, { host })
  await view.press({ text: 'Forget key' })
  assert.equal(cleared, 1)
  assert.ok(view.find({ label: 'Management key', type: 'Input' }))
  assert.equal(view.find({ text: 'Forget key' }), null, 'nothing left to forget')
  assert.equal(view.findAll({ type: 'Progress' }).length, 0)
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('while a poll runs, Refresh waits and the panel says so', async () => {
  const host = mockHost({ requests: { 'cpa.state': withAccounts(), 'cpa.refresh': () => withAccounts({ polling: true }) } })
  const view = await mount(panel, { host })
  await view.press({ text: 'Refresh' })
  assert.equal(view.find({ text: 'Refresh' })?.disabled, true)
  assert.ok(view.find({ text: /· polling now$/ }))
  await view.post('cpa.changed', withAccounts())
  assert.equal(view.find({ text: 'Refresh' })?.disabled, false)
  await view.unmount()
})

test('a saved key shows as connecting until the first poll ends', async () => {
  const host = mockHost({
    requests: {
      'cpa.state': unconfigured(null),
      'cpa.setKey': () => state({ polling: true, lastPollAt: null, status: { kind: 'connecting', message: null } })
    }
  })
  const view = await mount(panel, { host })
  await view.type({ label: 'Management key', type: 'Input' }, 'k', { submit: true })
  assert.ok(view.find({ type: 'Badge', text: 'connecting' }))
  assert.equal(view.find({ label: 'Management key', type: 'Input' }), null)
  assert.ok(view.find({ label: 'Not read yet' }))
  await view.post('cpa.changed', withAccounts())
  assert.ok(view.find({ type: 'Progress', label: /me@example\.com 5h/ }))
  await view.unmount()
})

test('changing the key can be cancelled while the key works', async () => {
  const host = mockHost({ requests: { 'cpa.state': withAccounts() } })
  const view = await mount(panel, { host })
  assert.equal(view.find({ label: 'Management key', type: 'Input' }), null)
  await view.press({ text: 'Change key' })
  assert.ok(view.find({ label: 'Management key', type: 'Input' }))
  await view.press({ text: 'Cancel' })
  assert.equal(view.find({ label: 'Management key', type: 'Input' }), null)
  await view.unmount()
})

test('before the first poll it says so', async () => {
  const host = mockHost({ requests: { 'cpa.state': state({ lastPollAt: null, status: { kind: 'unconfigured', message: null } }) } })
  const view = await mount(panel, { host })
  assert.ok(view.find({ label: 'Not read yet' }))
  assert.ok(view.find({ text: /^Not polled yet · every 5 min$/ }))
  await view.post('cpa.changed', state({ status: { kind: 'error', message: 'Cannot reach https://cpa.example.com.' } }))
  assert.equal(view.find({ type: 'EmptyState' }), null, 'the callout says why there is nothing to show')
  assert.equal(view.find({ type: 'Callout', text: /Cannot reach/ })?.props.tone, 'warning')
  assert.ok(view.find({ type: 'Badge', text: 'error' }))
  await view.unmount()
})

test('says when the worker does not answer', async () => {
  const host = mockHost({ requests: {} })
  const view = await mount(panel, { host })
  assert.ok(view.find({ type: 'Callout', text: /did not answer/ }))
  await view.unmount()
})
