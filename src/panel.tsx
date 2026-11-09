// The CLIProxyAPI usage panel. Everything it shows comes from the worker (src/worker.ts and
// src/collector.ts), which owns the management key and the network; the panel only asks and
// listens, and never sees the key after it is sent.
import {
  atom,
  Badge,
  Button,
  Callout,
  Card,
  EmptyState,
  Field,
  Heading,
  Input,
  KeyValue,
  plugin,
  read,
  RelativeTime,
  Row,
  Select,
  Spinner,
  Stack,
  set,
  Table,
  Text,
  type PanelContext,
  type TableRow
} from 'orca'
import type { UsageState } from './protocol'
import { compact, RANGES, type RangeId, type UsageRow } from './usage'

const usage = atom<UsageState | null>(null)
const range = atom<RangeId>('range', 'today', { persist: 'plugin' })
const keyDraft = atom('')
const editingKey = atom(false)
const busy = atom(false)
const failure = atom<string | null>(null)
/** The reset button asks once more before it deletes the counts. */
const confirmingReset = atom(false)

const RANGE_OPTIONS = RANGES.map((range) => ({ value: range.id, label: range.label }))
const rangeDays = (id: RangeId) => RANGES.find((candidate) => candidate.id === id)?.days ?? 1

async function run(action: () => Promise<UsageState>): Promise<void> {
  set(busy, true)
  set(failure, null)
  try {
    set(usage, await action())
  } catch (error) {
    set(failure, error instanceof Error ? error.message : String(error))
  } finally {
    set(busy, false)
  }
}

function saveKey(): Promise<void> {
  const key = read(keyDraft).trim()
  if (!key) return Promise.resolve()
  return run(async () => {
    const next = await plugin.request('cpa.setKey', { key }, { timeoutMs: 60_000 })
    set(keyDraft, '')
    set(editingKey, false)
    return next
  })
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('cpa.changed', (state) => set(usage, state)))
  void run(() => plugin.request('cpa.state'))
}

function tableRows(rows: readonly UsageRow[]): TableRow[] {
  return rows.map((row) => ({
    key: row.key,
    cells: {
      name: row.provider ? `${row.key} (${row.provider})` : row.key,
      requests: row.totals.requests,
      tokens: compact(row.totals.total),
      input: compact(row.totals.input),
      output: compact(row.totals.output),
      cached: compact(row.totals.cached),
      failed: row.totals.failed
    }
  }))
}

function usageTable(label: string, nameLabel: string, rows: readonly UsageRow[]) {
  return (
    <Table
      label={label}
      maxHeight="md"
      emptyText="No requests in this range."
      columns={[
        { key: 'name', label: nameLabel, minWidth: 'md' },
        { key: 'requests', label: 'Req', align: 'end', width: 'xs' },
        { key: 'tokens', label: 'Tokens', align: 'end', width: 'xs' },
        { key: 'input', label: 'In', align: 'end', width: 'xs', hideBelow: 'md' },
        { key: 'output', label: 'Out', align: 'end', width: 'xs', hideBelow: 'md' },
        { key: 'cached', label: 'Cached', align: 'end', width: 'xs', hideBelow: 'md' },
        { key: 'failed', label: 'Failed', align: 'end', width: 'xs', hideBelow: 'sm' }
      ]}
      rows={tableRows(rows)}
    />
  )
}

function resetCounts(): Promise<void> {
  set(confirmingReset, false)
  return run(() => plugin.request('cpa.reset'))
}

function resetButtons() {
  if (!read(confirmingReset)) {
    return (
      <Button variant="ghost" tone="danger" icon="delete" onPress={() => set(confirmingReset, true)}>
        Reset counts
      </Button>
    )
  }
  return (
    <Row gap="xs">
      <Button tone="danger" icon="delete" disabled={read(busy)} onPress={resetCounts}>
        Confirm reset
      </Button>
      <Button variant="ghost" onPress={() => set(confirmingReset, false)}>
        Cancel
      </Button>
    </Row>
  )
}

function keyForm(state: UsageState) {
  return (
    <Card
      title="Management key"
      description="The management.secret-key of CLIProxyAPI, not a client API key. Stored in this plugin's encrypted secrets on this computer and sent only to the server it is saved for."
    >
      <Stack gap="sm">
        <Input
          label="Management key"
          type="password"
          value={read(keyDraft)}
          onChange={(value) => set(keyDraft, value)}
          onSubmit={() => saveKey()}
        />
        <Row gap="xs">
          <Button tone="accent" disabled={read(busy) || !read(keyDraft).trim()} onPress={saveKey}>
            Save and connect
          </Button>
          {state.hasKey && state.status.kind !== 'auth' ? (
            <Button variant="ghost" onPress={() => set(editingKey, false)}>
              Cancel
            </Button>
          ) : null}
        </Row>
      </Stack>
    </Card>
  )
}

export default function Panel() {
  const state = read(usage)
  if (!state) {
    const error = read(failure)
    return error ? (
      <Callout tone="danger" title="The plugin worker did not answer">
        {error}
      </Callout>
    ) : (
      <Spinner label="Loading usage" />
    )
  }
  const selected = read(range)
  const view = state.views[selected]
  const totals = view.totals
  const showKeyForm = !state.hasKey || state.status.kind === 'auth' || read(editingKey)
  return (
    <Stack gap="md">
      <Row justify="between">
        <Heading>CLIProxyAPI</Heading>
        <Badge tone={state.status.tone}>{state.status.label}</Badge>
      </Row>
      {state.baseUrl ? (
        <Text muted size="xs" truncate>
          {state.baseUrl}
          {state.apiVersion ? ` · management ${state.apiVersion}` : ''}
        </Text>
      ) : null}

      {state.status.message && state.status.kind !== 'ok' ? (
        <Callout tone={state.status.tone === 'neutral' ? 'warning' : state.status.tone}>{state.status.message}</Callout>
      ) : null}
      {read(failure) ? <Callout tone="danger">{read(failure)}</Callout> : null}
      {state.statisticsEnabled === false ? (
        <Callout tone="warning" title="The server does not publish usage">
          Set observability.usage.usage-statistics-enabled: true in the CLIProxyAPI config (usage-statistics-enabled
          on servers before the v8 config), or nothing reaches the usage queue.
        </Callout>
      ) : null}

      {showKeyForm ? keyForm(state) : null}

      {state.hasKey ? (
        <Stack gap="md">
          <Select
            label="Range"
            labelHidden
            value={read(range)}
            options={RANGE_OPTIONS}
            onChange={(value) => set(range, value as RangeId)}
          />
          {rangeDays(selected) > state.retentionDays ? (
            <Text muted size="xs">
              {`Only the last ${state.retentionDays} ${state.retentionDays === 1 ? 'day is' : 'days are'} kept (Days of history to keep in the plugin settings).`}
            </Text>
          ) : null}
          {totals.requests === 0 ? (
            <EmptyState
              icon="gauge"
              title="No requests counted yet"
              description="The plugin counts requests from the moment it first reads the usage queue."
            />
          ) : (
            <Stack gap="md">
              <KeyValue
                label="Totals"
                items={[
                  { label: 'Requests', value: totals.requests },
                  { label: 'Failed', value: totals.failed, tone: totals.failed > 0 ? 'warning' : undefined },
                  { label: 'Tokens', value: compact(totals.total) },
                  { label: 'Input', value: compact(totals.input) },
                  { label: 'Output', value: compact(totals.output) },
                  { label: 'Cached', value: compact(totals.cached) },
                  { label: 'Reasoning', value: compact(totals.reasoning) },
                  {
                    label: 'Avg latency',
                    value: `${(totals.latencyMs / Math.max(1, totals.requests) / 1000).toFixed(1)} s`
                  }
                ]}
              />
              <Field label="By model">{usageTable('Usage by model', 'Model', view.models)}</Field>
              <Field label="By account">{usageTable('Usage by account', 'Account', view.accounts)}</Field>
            </Stack>
          )}
          <Text muted size="xs">
            {state.lastPollAt ? 'Last read ' : 'Not read yet'}
            {state.lastPollAt ? <RelativeTime at={state.lastPollAt} format="short" /> : null}
            {state.trackingSince ? ' · counting since ' : null}
            {state.trackingSince ? <RelativeTime at={state.trackingSince} format="long" /> : null}
          </Text>
          <Row gap="xs" wrap>
            <Button icon="refresh" disabled={read(busy)} onPress={() => run(() => plugin.request('cpa.refresh'))}>
              Refresh
            </Button>
            <Button variant="ghost" icon="edit" onPress={() => set(editingKey, true)}>
              Change key
            </Button>
            {resetButtons()}
          </Row>
          <Text muted size="xs">
            Reading the usage queue removes its records on the server. Run no other consumer of the queue (a usage
            service, a dashboard, or on servers before v8 the Redis-compatible endpoint) at the same time, or each sees
            only part of it.
          </Text>
        </Stack>
      ) : null}
    </Stack>
  )
}
