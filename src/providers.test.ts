import { assert, test } from 'orca/testing'
import manifest from '../orca-plugin.json' with { type: 'json' }
import type { Account } from './accounts'
import { antigravitySummary, claudeProfile, claudeUsage, codexUsage, NOW, UPSTREAM } from './fixtures'
import {
  type Delivery,
  hasQuota,
  isAllowedUpstream,
  MAX_REQUESTS_PER_READ,
  MAX_WINDOWS,
  type Plan,
  providerName,
  type QuotaResult,
  readQuota,
  type UpstreamRequest,
  USER_AGENT
} from './providers'
import { cleanText } from './untrusted'
import { PLUGIN_VERSION } from './version'

const account = (provider: string, extra: Partial<Account> = {}): Account => ({
  id: 'x1',
  authIndex: 'x1',
  name: `${provider}.json`,
  provider,
  email: 'me@example.com',
  label: null,
  disabled: false,
  details: {},
  ...extra
})

type Reply = { status: number; body?: unknown; raw?: string } | { failed: string }

/** Answers each request from `replies` by URL (a list is used up in order), and records them. */
function stub(replies: Record<string, Reply | Reply[]>) {
  const sent: UpstreamRequest[] = []
  const send = async (request: UpstreamRequest): Promise<Delivery> => {
    sent.push(request)
    const entry = replies[request.url]
    const reply = Array.isArray(entry) ? entry.shift() : entry
    if (!reply) return { status: 404, body: '' }
    if ('failed' in reply) return reply
    return { status: reply.status, body: reply.raw ?? JSON.stringify(reply.body ?? '') }
  }
  return { send, sent, urls: () => sent.map((request) => request.url) }
}

const { claudeUsage: CLAUDE_USAGE, claudeProfile: CLAUDE_PROFILE, codexUsage: CODEX_USAGE, antigravity: AG } = UPSTREAM

function ok(result: QuotaResult): asserts result is QuotaResult & { ok: true } {
  assert.ok(result.ok, result.ok ? '' : result.error)
}
function failed(result: QuotaResult): asserts result is QuotaResult & { ok: false } {
  assert.equal(result.ok, false)
}
const options = (plan: Plan = undefined) => ({ now: NOW, plan })

test('Claude: every window with a utilization, the extra usage note, and the plan from the profile', async () => {
  const upstream = stub({ [CLAUDE_USAGE]: { status: 200, body: claudeUsage() }, [CLAUDE_PROFILE]: { status: 200, body: claudeProfile } })
  const result = await readQuota(account('claude'), upstream.send, options())
  ok(result)
  assert.deepEqual(
    result.windows.map((window) => [window.label, window.usedPercent, window.limitReached]),
    [
      ['5h', 62, false],
      ['7d', 30.5, false],
      ['7d Sonnet', 12, false]
    ]
  )
  assert.equal(result.windows[0].resetsAt, NOW + 2.34 * 3_600_000)
  assert.equal(result.plan, 'Max 5x')
  assert.deepEqual(result.notes, ['Extra usage: 5% of the monthly limit used.'])
  assert.deepEqual(upstream.urls(), [CLAUDE_USAGE, CLAUDE_PROFILE])
  const [usage] = upstream.sent
  assert.equal(usage.method, 'GET')
  assert.equal(usage.header.Authorization, 'Bearer $TOKEN$')
  assert.equal(usage.header['anthropic-beta'], 'oauth-2025-04-20')
  assert.equal(usage.header['User-Agent'], USER_AGENT)
  assert.equal(JSON.stringify(result).includes('UPSTREAM-BODY-MARKER'), false, 'unknown upstream fields are dropped')
})

test('Claude: a known plan, also "none", skips the profile', async () => {
  for (const plan of ['Pro', null]) {
    const known = stub({ [CLAUDE_USAGE]: { status: 200, body: claudeUsage() } })
    const result = await readQuota(account('claude'), known.send, options(plan))
    ok(result)
    assert.equal(result.plan, plan)
    assert.deepEqual(known.urls(), [CLAUDE_USAGE])
  }
})

test('Claude: what a profile answer means for the plan', async () => {
  const cases: [Reply, Plan, string | undefined][] = [
    [{ status: 200, body: { account: {} } }, null, undefined],
    [{ status: 200, body: { account: { has_claude_max: false, has_claude_pro: false } } }, 'Free', undefined],
    [{ status: 200, raw: 'not json' }, null, undefined],
    [{ status: 403, raw: '' }, null, undefined],
    [{ status: 404, raw: '' }, null, undefined],
    [{ status: 500, raw: 'boom' }, undefined, undefined],
    [{ failed: 'request failed' }, undefined, undefined],
    [{ status: 429, raw: '' }, undefined, 'rate-limited']
  ]
  for (const [profile, plan, rest] of cases) {
    const upstream = stub({ [CLAUDE_USAGE]: { status: 200, body: claudeUsage() }, [CLAUDE_PROFILE]: profile })
    const result = await readQuota(account('claude'), upstream.send, options())
    ok(result)
    assert.equal(result.plan, plan, JSON.stringify(profile))
    assert.equal(result.rest, rest, JSON.stringify(profile))
    assert.equal(result.windows.length, 3, 'the windows are read either way')
  }
})

test('Claude: iguana_necktie is the weekly Fable window unless limits[] has one or it is a credit pool', async () => {
  const fable = { utilization: 70, resets_at: '2026-11-12T10:00:00Z' }
  const read = async (body: unknown) => {
    const result = await readQuota(account('claude'), stub({ [CLAUDE_USAGE]: { status: 200, body } }).send, options('Max'))
    ok(result)
    return result.windows.map((window) => [window.label, window.usedPercent])
  }
  assert.deepEqual(await read({ five_hour: { utilization: 10 }, iguana_necktie: fable }), [
    ['5h', 10],
    ['7d Fable', 70]
  ])
  const limit = { kind: 'weekly_scoped', percent: 40, scope: { model: { display_name: 'Fable' } } }
  assert.deepEqual(await read({ five_hour: { utilization: 10 }, iguana_necktie: fable, limits: [limit] }), [
    ['5h', 10],
    ['7d Fable', 40]
  ])
  const pool = { ...fable, limit_dollars: 50, used_dollars: 35, remaining_dollars: 15 }
  assert.deepEqual(await read({ five_hour: { utilization: 10 }, iguana_necktie: pool }), [['5h', 10]])
})

test('Claude: per-model weekly limits and plan tiers', async () => {
  const body = {
    five_hour: { utilization: 100, resets_at: null },
    limits: [
      { kind: 'weekly_scoped', percent: 40, resets_at: '2026-11-12T10:00:00Z', scope: { model: { display_name: 'Fable' } } },
      { kind: 'session', percent: 99, scope: { model: { display_name: 'Ignored' } } },
      { kind: 'weekly_scoped', percent: 'n/a', scope: { model: { display_name: 'NoPercent' } } }
    ]
  }
  const team = { organization: { organization_type: 'claude_team', subscription_status: 'active' } }
  const upstream = stub({ [CLAUDE_USAGE]: { status: 200, body }, [CLAUDE_PROFILE]: { status: 200, body: team } })
  const result = await readQuota(account('claude'), upstream.send, options())
  ok(result)
  assert.deepEqual(
    result.windows.map((window) => [window.label, window.usedPercent, window.resetsAt, window.limitReached]),
    [
      ['5h', 100, null, true],
      ['7d Fable', 40, Date.parse('2026-11-12T10:00:00Z'), false]
    ]
  )
  assert.equal(result.plan, 'Team')
})

test('Codex: primary and secondary windows, resets, plan and the account header', async () => {
  const upstream = stub({ [CODEX_USAGE]: { status: 200, body: codexUsage() } })
  const result = await readQuota(account('codex', { details: { chatgptAccountId: 'acct-123' } }), upstream.send, options())
  ok(result)
  assert.deepEqual(
    result.windows.map((window) => [window.label, window.usedPercent, window.resetsAt]),
    [
      ['5h', 58, NOW + 3_600_000],
      ['7d', 20, NOW + 400_000_000]
    ]
  )
  assert.equal(result.plan, 'Plus')
  assert.equal(upstream.sent[0].header['Chatgpt-Account-Id'], 'acct-123')
  assert.equal(upstream.sent[0].method, 'GET')

  const noId = stub({ [CODEX_USAGE]: { status: 200, body: codexUsage() } })
  await readQuota(account('codex'), noId.send, options())
  assert.equal('Chatgpt-Account-Id' in noId.sent[0].header, false)
})

test('Codex: limit reached, missing percent, code review and additional limits, other durations', async () => {
  const body = {
    rate_limit: {
      allowed: false,
      limit_reached: true,
      primary_window: { used_percent: 100, limit_window_seconds: 18_000 },
      secondary_window: { used_percent: 70 }
    },
    code_review_rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 2_592_000 } },
    additional_rate_limits: [
      { limit_name: 'GPT-5 Pro', rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 7_200 } } },
      { metered_feature: 'Images', rate_limit: { limit_reached: true, primary_window: { limit_window_seconds: 864_000 } } },
      { rate_limit: { primary_window: { used_percent: 1 } } }
    ],
    credits: { has_credits: true, balance: '12.5' }
  }
  const upstream = stub({ [CODEX_USAGE]: { status: 200, body } })
  const result = await readQuota(account('codex', { details: { planType: 'team' } }), upstream.send, options())
  ok(result)
  assert.deepEqual(
    result.windows.map((window) => [window.label, window.usedPercent, window.limitReached]),
    [
      ['5h', 100, true],
      ['7d', 70, false],
      ['Code review 30d', 10, false],
      ['GPT-5 Pro 2h', 5, false],
      ['Images 10d', 100, true]
    ]
  )
  assert.equal(result.plan, 'Team', 'falls back to the id token plan')
  assert.deepEqual(result.notes, ['Credits: 12.5.'])
})

test('Antigravity: remaining fractions become percent used, from the first host that answers', async () => {
  const upstream = stub({ [AG[0]]: { status: 200, body: antigravitySummary() } })
  const result = await readQuota(account('antigravity', { details: { projectId: 'proj-42' } }), upstream.send, options())
  ok(result)
  assert.deepEqual(
    result.windows.map((window) => [window.label, window.usedPercent]),
    [
      ['Gemini 5h', 25],
      ['Gemini 7d', 60],
      ['Claude 5h', 0]
    ]
  )
  assert.equal(result.windows[2].resetsAt, null)
  assert.deepEqual(upstream.urls(), [AG[0]])
  assert.equal(upstream.sent[0].method, 'POST')
  assert.equal(upstream.sent[0].data, '{"project":"proj-42"}')
  assert.equal(upstream.sent[0].header['Content-Type'], 'application/json')
})

test('Antigravity: tries the fallback hosts in order and stops at a refused token', async () => {
  const fallback = stub({ [AG[0]]: { status: 503, raw: 'down' }, [AG[1]]: { status: 200, body: { groups: [] } }, [AG[2]]: { status: 200, body: antigravitySummary() } })
  const result = await readQuota(account('antigravity', { details: { projectId: 'p' } }), fallback.send, options())
  ok(result)
  assert.deepEqual(fallback.urls(), AG)

  const refused = stub({ [AG[0]]: { status: 401, raw: '' } })
  const denied = await readQuota(account('antigravity', { details: { projectId: 'p' } }), refused.send, options())
  failed(denied)
  assert.match(denied.error, /upstream 401/)
  assert.deepEqual(refused.urls(), [AG[0]])

  const forbidden = stub({ [AG[0]]: { status: 404, raw: '' }, [AG[1]]: { status: 403, raw: '' }, [AG[2]]: { status: 500, raw: '' } })
  const worst = await readQuota(account('antigravity', { details: { projectId: 'p' } }), forbidden.send, options())
  failed(worst)
  assert.match(worst.error, /refused the quota request \(upstream 403\)/, 'the telling status wins')
  assert.equal(worst.rest, 'refused')
})

test('Antigravity: a 429 stops at once and is not hidden by an earlier 403', async () => {
  const limited = stub({ [AG[0]]: { status: 429, raw: '' } })
  const first = await readQuota(account('antigravity', { details: { projectId: 'p' } }), limited.send, options())
  failed(first)
  assert.deepEqual(limited.urls(), [AG[0]], 'the other hosts are not asked')
  assert.equal(first.rest, 'rate-limited')

  const late = stub({ [AG[0]]: { status: 403, raw: '' }, [AG[1]]: { status: 429, raw: '' } })
  const second = await readQuota(account('antigravity', { details: { projectId: 'p' } }), late.send, options())
  failed(second)
  assert.match(second.error, /upstream 429/)
  assert.equal(second.rest, 'rate-limited')
  assert.deepEqual(late.urls(), AG.slice(0, 2))
})

test('Antigravity: window spellings and snake_case fields as the Management Center reads them', async () => {
  const body = {
    groups: [
      {
        display_name: 'Gemini',
        buckets: [
          { window: 'five-hour', remaining_fraction: 0.9, reset_time: '2026-11-09T15:00:00Z' },
          { window: 'FIVE_HOUR', remainingFraction: 0.8 },
          { window: 'week', remainingFraction: 0.5 },
          { window: 'Daily', remainingFraction: 0.6 },
          { window: 'monthly', remainingFraction: 0.25 }
        ]
      }
    ]
  }
  const result = await readQuota(account('antigravity', { details: { projectId: 'p' } }), stub({ [AG[0]]: { status: 200, body } }).send, options())
  ok(result)
  assert.deepEqual(
    result.windows.map((window) => [window.label, window.usedPercent]),
    [
      ['Gemini 5h', 10],
      ['Gemini 5h (2)', 20],
      ['Gemini 7d', 50],
      ['Gemini 1d', 40],
      ['Gemini monthly', 75]
    ]
  )
  assert.equal(result.windows[0].resetsAt, Date.parse('2026-11-09T15:00:00Z'))
})

test('Antigravity without a project sends nothing', async () => {
  const upstream = stub({})
  const result = await readQuota(account('antigravity'), upstream.send, options())
  failed(result)
  assert.match(result.error, /no Google Cloud project/)
  assert.equal(upstream.sent.length, 0)
})

test('a repeated label takes the bucket\'s own name, else a number', async () => {
  const body = {
    groups: [
      {
        displayName: 'G',
        buckets: [
          { window: '5h', remainingFraction: 0.5, displayName: 'Flash' },
          { window: '5h', remainingFraction: 0.4, displayName: 'Pro' },
          { window: '5h', remainingFraction: 0.3 }
        ]
      },
      { buckets: [{ remainingFraction: 0.1 }] },
      { buckets: [{ remainingFraction: 0.2, display_name: 'Named' }] }
    ]
  }
  const result = await readQuota(account('antigravity', { details: { projectId: 'p' } }), stub({ [AG[0]]: { status: 200, body } }).send, options())
  ok(result)
  assert.deepEqual(result.windows.map((window) => window.label), ['G 5h', 'G Pro', 'G 5h (2)', 'Quota', 'Named'])
})

test('upstream statuses become per-account errors; 401, 403 and 429 ask for a rest', async () => {
  const cases: [number, RegExp, string | undefined][] = [
    [401, /rejected the account's token \(upstream 401\).*sign in/, 'refused'],
    [403, /refused the quota request \(upstream 403\)/, 'refused'],
    [404, /upstream 404/, undefined],
    [429, /rate-limited the quota request \(upstream 429\)/, 'rate-limited'],
    [500, /answered upstream HTTP 500/, undefined]
  ]
  for (const [status, pattern, rest] of cases) {
    const result = await readQuota(account('claude'), stub({ [CLAUDE_USAGE]: { status, raw: 'SECRET-BODY' } }).send, options())
    failed(result)
    assert.match(result.error, pattern)
    assert.equal(result.error.includes('SECRET-BODY'), false, 'upstream bodies never reach an error')
    assert.equal(result.rest, rest, String(status))
  }

  const relayed = await readQuota(account('codex'), stub({ [CODEX_USAGE]: { failed: 'CLIProxyAPI: auth token refresh failed' } }).send, options())
  failed(relayed)
  assert.equal(relayed.error, 'CLIProxyAPI: auth token refresh failed')
})

test('malformed bodies are errors, never crashes, and nothing of them leaks', async () => {
  const bodies: Reply[] = [
    { status: 200, raw: '<html>SECRET</html>' },
    { status: 200, raw: '' },
    { status: 200, body: null },
    { status: 200, body: [] },
    { status: 200, body: 'five_hour' },
    { status: 200, body: { five_hour: 'SECRET' } },
    { status: 200, body: { five_hour: { utilization: 'lots' } } },
    { status: 200, body: { five_hour: { utilization: null } } }
  ]
  for (const reply of bodies) {
    const result = await readQuota(account('claude'), stub({ [CLAUDE_USAGE]: reply }).send, options('Pro'))
    failed(result)
    assert.match(result.error, /does not know|no quota windows/)
    assert.equal(result.error.includes('SECRET'), false)
  }
  for (const body of [{ rate_limit: 'x' }, { rate_limit: { primary_window: { used_percent: 'NaN' } } }, {}]) {
    failed(await readQuota(account('codex'), stub({ [CODEX_USAGE]: { status: 200, body } }).send, options()))
  }
  for (const body of [{ groups: 'x' }, { groups: [{ buckets: [{ remainingFraction: 'half' }] }] }, { groups: [null, 1, 'x'] }]) {
    failed(await readQuota(account('antigravity', { details: { projectId: 'p' } }), stub({ [AG[0]]: { status: 200, body }, [AG[1]]: { status: 200, body }, [AG[2]]: { status: 200, body } }).send, options()))
  }
})

test('numbers are clamped and checked, labels capped and cleaned, windows capped and unique', async () => {
  const body = {
    five_hour: { utilization: 250, resets_at: 'not a date' },
    seven_day: { utilization: -20, resets_at: 1e300 },
    seven_day_sonnet: { utilization: '99.96', resets_at: '1762700000' },
    seven_day_opus: { utilization: Number.MAX_VALUE },
    limits: Array.from({ length: 40 }, (_, index) => ({
      kind: 'weekly_scoped',
      percent: index,
      scope: { model: { display_name: `M\u0000odel\u202e ${index}${index === 0 ? 'x'.repeat(100) : ''}` } }
    }))
  }
  const result = await readQuota(account('claude'), stub({ [CLAUDE_USAGE]: { status: 200, body } }).send, options('Pro'))
  ok(result)
  assert.equal(result.windows.length, MAX_WINDOWS)
  const [five, seven, opus, sonnet, first] = result.windows
  assert.deepEqual([five.usedPercent, five.resetsAt, five.limitReached], [100, null, true])
  assert.deepEqual([seven.usedPercent, seven.resetsAt], [0, null])
  assert.deepEqual(
    [sonnet.label, sonnet.usedPercent, sonnet.resetsAt, sonnet.limitReached],
    ['7d Sonnet', 99.96, 1_762_700_000_000, false],
    'kept as precise as said; only the display rounds'
  )
  assert.equal(opus.usedPercent, 100)
  assert.ok(first.label.length <= 43, 'model names are capped')
  assert.equal(/[\u0000\u202e]/.test(first.label), false, 'control and bidi characters are dropped')
  assert.equal(new Set(result.windows.map((window) => window.label)).size, MAX_WINDOWS, 'labels are unique')
  assert.ok(result.windows.every((window) => Number.isFinite(window.usedPercent) && window.usedPercent >= 0 && window.usedPercent <= 100))
})

test('prototype keys in bodies are plain data', async () => {
  const raw = '{"__proto__":{"polluted":true},"five_hour":{"utilization":10,"__proto__":{"utilization":99}},"constructor":{"utilization":50}}'
  const result = await readQuota(account('claude'), stub({ [CLAUDE_USAGE]: { status: 200, raw } }).send, options('Pro'))
  ok(result)
  assert.deepEqual(result.windows.map((window) => [window.label, window.usedPercent]), [['5h', 10]])
  assert.equal(({} as Record<string, unknown>).polluted, undefined)
})

test('unsupported providers are not asked', async () => {
  const upstream = stub({})
  for (const provider of ['gemini-cli', 'vertex', 'kimi', 'unknown']) {
    const result = await readQuota(account(provider), upstream.send, options())
    failed(result)
    assert.match(result.error, /not available/)
  }
  assert.equal(upstream.sent.length, 0)
  assert.equal(hasQuota('gemini-cli'), false)
  assert.ok(hasQuota('claude') && hasQuota('codex') && hasQuota('antigravity'))
  assert.equal(providerName('gemini-cli'), 'Gemini CLI')
  assert.equal(providerName('claude'), 'Claude')
  assert.equal(providerName('someprovider'), 'Someprovider')
})

test('a read sends at most MAX_REQUESTS_PER_READ requests, whatever the answers', async () => {
  const cases: [Account, Reply][] = [
    [account('antigravity', { details: { projectId: 'p' } }), { status: 503, raw: '' }],
    [account('antigravity', { details: { projectId: 'p' } }), { failed: 'request failed' }],
    [account('claude'), { status: 200, body: claudeUsage() }],
    [account('codex'), { status: 500, raw: '' }]
  ]
  for (const [entry, reply] of cases) {
    let sent = 0
    await readQuota(
      entry,
      async () => {
        sent += 1
        return 'failed' in reply ? reply : { status: reply.status, body: reply.raw ?? JSON.stringify(reply.body) }
      },
      options()
    )
    assert.ok(sent >= 1 && sent <= MAX_REQUESTS_PER_READ, `${entry.provider}: ${sent}`)
  }
})

// Written out by hand on purpose, not taken from the fixtures: this is the list to review.
test('the allowlist holds exactly the fixed quota requests', async () => {
  const sent: UpstreamRequest[] = []
  const recordAll = async (request: UpstreamRequest): Promise<Delivery> => {
    sent.push(request)
    return { status: 503, body: '' }
  }
  await readQuota(account('claude'), recordAll, options())
  await readQuota(account('codex', { details: { chatgptAccountId: 'a' } }), recordAll, options())
  await readQuota(account('antigravity', { details: { projectId: 'p' } }), recordAll, options())
  // The plan request runs only after a usage success.
  await readQuota(account('claude'), async (request) => {
    sent.push(request)
    return { status: 200, body: JSON.stringify(claudeUsage()) }
  }, options())
  assert.ok(sent.every((request) => isAllowedUpstream(request.method, request.url)))
  assert.ok(sent.every((request) => request.url.startsWith('https://')))
  assert.ok(
    sent.every((request) => Object.entries(request.header).every(([name, value]) => !value.includes('$TOKEN$') || name === 'Authorization')),
    '$TOKEN$ goes only into the Authorization header'
  )
  assert.ok(sent.every((request) => !request.url.includes('$TOKEN$') && !(request.data ?? '').includes('$TOKEN$')))
  assert.deepEqual(
    [...new Set(sent.map((request) => `${request.method} ${request.url}`))].sort(),
    [
      'GET https://api.anthropic.com/api/oauth/profile',
      'GET https://api.anthropic.com/api/oauth/usage',
      'GET https://chatgpt.com/backend-api/wham/usage',
      'POST https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
      'POST https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary',
      'POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary'
    ].sort()
  )
  for (const [method, url] of [
    ['POST', 'https://api.anthropic.com/api/oauth/usage'],
    ['GET', 'https://api.anthropic.com/api/oauth/usage?x=1'],
    ['GET', 'http://api.anthropic.com/api/oauth/usage'],
    ['POST', 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume'],
    ['GET', 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits'],
    ['POST', 'https://api.anthropic.com/api/organizations/org/reset_rate_limits'],
    ['GET', 'https://cpa.example.com/v8/management/credentials/download'],
    ['POST', 'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist']
  ]) {
    assert.equal(isAllowedUpstream(method, url), false, `${method} ${url}`)
  }
})

test('cleanText trims, strips unprintable characters and caps', () => {
  assert.equal(cleanText('  a\u0007b\u202ec  '), 'abc')
  assert.equal(cleanText('x'.repeat(500))?.length, 200)
  assert.equal(cleanText('abcdef', 3), 'abc')
  assert.equal(cleanText('   '), null)
  assert.equal(cleanText(42), null)
})

test('the User-Agent names this plugin at the manifest\'s version', () => {
  assert.equal(PLUGIN_VERSION, manifest.version)
  assert.equal(USER_AGENT, `orca-cliproxyapi-quota/${manifest.version}`)
})
