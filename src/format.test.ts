import { assert, test } from 'orca/testing'
import { NOW } from './fixtures'
import {
  formatPercent,
  formatReset,
  MESSAGES,
  type Overview,
  resetText,
  STATUS,
  STATUS_TEXT_CHARS,
  statusBarItem,
  summaryText,
  windowTone
} from './format'
import type { AccountView, StatusKind } from './protocol'
import type { Window } from './providers'

// NOW is Monday 9 Nov 2026, 12:00 local time.
const local = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).getTime()
const w = (label: string, usedPercent: number, resetsAt: number | null = null, limitReached = false): Window => ({
  label,
  usedPercent,
  resetsAt,
  limitReached
})
const view = (kind: AccountView['kind'], windows: Window[], provider = 'Claude', extra: Partial<AccountView> = {}): AccountView => ({
  id: provider + kind + windows.length,
  kind,
  provider,
  title: 't',
  plan: null,
  windows,
  notes: [],
  error: null,
  updatedAt: NOW,
  missed: false,
  ...extra
})
const overview = (kind: StatusKind, accounts: AccountView[], message: string | null = null): Overview => ({
  status: { kind, message },
  accounts,
  omitted: 0,
  lastPollAt: NOW
})
const barText = (accounts: AccountView[]) => statusBarItem(overview('ok', accounts), NOW).text

test('reset times read in local time, as short as stays clear', () => {
  assert.equal(formatReset(local(9, 14, 20), NOW), '14:20')
  assert.equal(formatReset(local(10, 9, 5), NOW), 'Tue 09:05')
  assert.equal(formatReset(local(15, 23, 59), NOW), 'Sun 23:59')
  assert.equal(formatReset(local(16, 0, 0), NOW), '16 Nov 00:00', 'a week ahead names the date')
  assert.equal(formatReset(local(9, 8, 0), NOW), '9 Nov 08:00', 'a time already passed names the date')
})

test('percent is whole and honest at the edges', () => {
  assert.equal(formatPercent(0), '0%')
  assert.equal(formatPercent(0.4), '<1%')
  assert.equal(formatPercent(62.4), '62%')
  assert.equal(formatPercent(99.9), '99%')
  assert.equal(formatPercent(99.96), '99%', 'only a full window reads 100%')
  assert.equal(formatPercent(100), '100%')
})

test('tones: neutral below 80, warning from 80, danger from 95 or at the limit', () => {
  assert.equal(windowTone(w('5h', 79.9)), 'neutral')
  assert.equal(windowTone(w('5h', 80)), 'warning')
  assert.equal(windowTone(w('5h', 94.9)), 'warning')
  assert.equal(windowTone(w('5h', 95)), 'danger')
  assert.equal(windowTone(w('5h', 10, null, true)), 'danger')
})

test('the summary describes each window with its reset', () => {
  const lines = summaryText(overview('ok', [view('quota', [w('5h', 62, local(9, 14, 20)), w('7d', 100, null, true)])]), NOW).split('\n')
  assert.deepEqual(lines, ['CLIProxyAPI quota', 'Claude t: 5h 62% · resets 14:20, 7d 100% (limit reached)'])
  assert.equal(resetText(local(9, 8, 0), NOW), 'reset 9 Nov 08:00')
})

test('the status bar shows the fullest window across enabled accounts, past resets ignored, limit reached first', () => {
  assert.equal(barText([]), 'CPA quota')
  const pick = barText([
    view('quota', [w('5h', 50, NOW + 10), w('7d', 99, NOW - 1)]),
    view('quota', [w('5h', 70, local(9, 18)), w('7d', 70, local(9, 15))], 'Codex'),
    view('disabled', [w('5h', 100, null, true)])
  ])
  assert.equal(pick, 'Codex 7d 70% · 15:00', 'equal percent: the earlier reset')
  assert.equal(barText([view('quota', [w('a', 90), w('b', 10, null, true)])]), 'Claude b 10%')
  const long = barText([view('quota', [w('x'.repeat(100), 50)], 'Antigravity')])
  assert.equal(long.length, STATUS_TEXT_CHARS)
  assert.ok(long.endsWith('…'))
})

test('status bar while ok: the tightest window, toned by the quota alone', () => {
  const cases: [number, boolean, string][] = [
    [62, false, 'neutral'],
    [79, false, 'neutral'],
    [80, false, 'warning'],
    [94, false, 'warning'],
    [95, false, 'danger'],
    [40, true, 'danger']
  ]
  for (const [used, reached, tone] of cases) {
    const item = statusBarItem(overview('ok', [view('quota', [w('5h', used, local(9, 14, 20), reached)])]), NOW)
    assert.equal(item.tone, tone, `${used} %`)
    assert.equal(item.text, `Claude 5h ${formatPercent(used)} · 14:20`)
  }
  assert.equal(statusBarItem(overview('ok', []), NOW).tone, 'neutral')
})

test('status bar otherwise: the status from the STATUS table, never stale numbers', () => {
  const accounts = [view('quota', [w('5h', 62, local(9, 14, 20))])]
  const cases: [StatusKind, string, string][] = [
    ['auth', 'CPA: key refused', 'danger'],
    ['error', 'CPA: error', 'warning'],
    ['unconfigured', 'CPA: set up', 'neutral'],
    ['connecting', 'CPA: connecting', 'neutral']
  ]
  for (const [kind, text, tone] of cases) {
    const item = statusBarItem(overview(kind, accounts, 'Something is wrong.'), NOW)
    assert.deepEqual([item.text, item.tone], [text, tone], kind)
    assert.deepEqual(STATUS[kind].bar, { text, tone })
    assert.match(item.tooltip, /^CLIProxyAPI quota: Something is wrong\.\nClaude t: 5h 62%$/)
  }
  assert.deepEqual([STATUS.ok.label, STATUS.ok.tone, STATUS.ok.bar], ['connected', 'success', null])
  assert.equal(STATUS.auth.messageTone, 'danger')
})

test('a missed account keeps its numbers and says it was not read this poll', () => {
  const missed = view('quota', [w('5h', 62, local(9, 14, 20))], 'Claude', { missed: true, error: 'old failure' })
  assert.equal(statusBarItem(overview('ok', [missed]), NOW).tooltip, 'Claude t: 5h 62% (not read this poll)')
  assert.equal(summaryText(overview('ok', [missed]), NOW).split('\n')[1], 'Claude t: 5h 62% · resets 14:20 (not read this poll)')
})

test('the summary lists the status message and every account', () => {
  const text = summaryText(overview('error', [view('quota', [w('5h', 62, local(9, 14, 20))])], 'Cannot reach it.'), NOW)
  assert.deepEqual(text.split('\n'), ['CLIProxyAPI quota', 'Cannot reach it.', 'Claude t: 5h 62% · resets 14:20'])
  assert.deepEqual(summaryText({ ...overview('ok', []), lastPollAt: null }, NOW).split('\n'), ['CLIProxyAPI quota', 'Not read yet.'])
})

test('a rest says when the account is asked again, and whether Refresh asks sooner', () => {
  assert.equal(MESSAGES.restsUntil('refused', local(9, 12, 30), NOW), 'Asked again at 12:30, or on Refresh.')
  assert.equal(MESSAGES.restsUntil('rate-limited', local(9, 12, 15), NOW), 'Asked again at 12:15.')
  assert.equal(MESSAGES.pausedUntil('Banned.', local(9, 12, 30), NOW), 'Banned. Polling resumes at 12:30.')
})
