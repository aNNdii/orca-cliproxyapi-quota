// The CLIProxyAPI quota panel. Everything it shows comes from the worker (src/worker.ts and
// src/collector.ts), which owns the management key and the network; the panel only asks and
// listens, and never sees the key after it is sent.
import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
  Card,
  EmptyState,
  Heading,
  Input,
  plugin,
  Progress,
  read,
  RelativeTime,
  Row,
  Spinner,
  Stack,
  set,
  Text,
  type PanelContext
} from 'orca'
import { formatPercent, resetText, STATUS, windowTone } from './format'
import type { AccountView, QuotaState } from './protocol'
import type { Window } from './providers'

const quota = atom<QuotaState | null>(null)
const keyDraft = atom('')
const editingKey = atom(false)
const busy = atom(false)
const failure = atom<string | null>(null)

async function run(action: () => Promise<QuotaState>): Promise<void> {
  set(busy, true)
  set(failure, null)
  try {
    set(quota, await action())
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
    // The worker answers once the key is stored; the poll's result arrives as `cpa.changed`.
    const next = await plugin.request('cpa.setKey', { key })
    set(keyDraft, '')
    set(editingKey, false)
    return next
  })
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('cpa.changed', (state) => set(quota, state)))
  void run(() => plugin.request('cpa.state'))
}

function keyForm(state: QuotaState) {
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

function windowRow(account: AccountView, window: Window, now: number) {
  const tone = windowTone(window)
  const used = `${formatPercent(window.usedPercent)} used${window.limitReached ? ' · limit reached' : ''}`
  return (
    <Stack key={window.label} gap="xs">
      <Row justify="between" gap="sm">
        <Text size="sm">{window.label}</Text>
        <Text size="sm" tone={tone === 'neutral' ? undefined : tone}>
          {used}
        </Text>
      </Row>
      <Progress label={`${account.provider} ${account.title} ${window.label} used`.slice(0, 120)} labelHidden value={window.usedPercent} />
      {window.resetsAt !== null ? (
        <Text muted size="xs">
          {resetText(window.resetsAt, now)}
        </Text>
      ) : null}
    </Stack>
  )
}

function accountBody(account: AccountView, now: number) {
  if (account.kind === 'disabled') {
    return (
      <Text muted size="sm">
        Disabled in CLIProxyAPI; its quota is not read.
      </Text>
    )
  }
  if (account.kind === 'unsupported') {
    return (
      <Text muted size="sm">
        {`Quota not available for ${account.provider} accounts.`}
      </Text>
    )
  }
  return (
    <Stack gap="sm">
      {account.windows.map((window) => windowRow(account, window, now))}
      {account.notes.map((note) => (
        <Text key={note} muted size="xs">
          {note}
        </Text>
      ))}
      {account.error ? (
        <Text size="xs" tone="warning">
          {account.windows.length > 0 ? `Last read failed: ${account.error}` : account.error}
        </Text>
      ) : null}
      {account.missed ? (
        <Text size="xs" tone="warning">
          Not read this poll: it stopped before reaching this account, which goes first in the next one.
        </Text>
      ) : null}
      <Text muted size="xs">
        {account.updatedAt ? 'Updated ' : account.error ? 'No successful read yet' : 'Not read yet'}
        {account.updatedAt ? <RelativeTime at={account.updatedAt} format="short" /> : null}
      </Text>
    </Stack>
  )
}

function accountBox(account: AccountView, now: number) {
  const greyed = account.kind !== 'quota'
  return (
    <Box key={account.id} border radius="md" padding="sm" gap="sm" background={greyed ? 'muted' : undefined}>
      <Row justify="between" gap="xs">
        <Text weight="semibold" truncate muted={greyed}>
          {`${account.provider} · ${account.title}`}
        </Text>
        {account.kind === 'disabled' ? <Badge>disabled</Badge> : account.plan ? <Badge>{account.plan}</Badge> : null}
      </Row>
      {accountBody(account, now)}
    </Box>
  )
}

export default function Panel() {
  const state = read(quota)
  if (!state) {
    const error = read(failure)
    return error ? (
      <Callout tone="danger" title="The plugin worker did not answer">
        {error}
      </Callout>
    ) : (
      <Spinner label="Loading quota" />
    )
  }
  const now = Date.now()
  const showKeyForm = !state.hasKey || state.status.kind === 'auth' || read(editingKey)
  const status = STATUS[state.status.kind]
  return (
    <Stack gap="md">
      <Row justify="between">
        <Heading>CLIProxyAPI quota</Heading>
        <Badge tone={status.tone}>{status.label}</Badge>
      </Row>
      {state.baseUrl ? (
        <Text muted size="xs" truncate>
          {state.baseUrl}
          {state.apiVersion ? ` · management ${state.apiVersion}` : ''}
        </Text>
      ) : null}

      {state.status.message && state.status.kind !== 'ok' ? (
        <Callout tone={status.messageTone}>{state.status.message}</Callout>
      ) : null}
      {read(failure) ? <Callout tone="danger">{read(failure)}</Callout> : null}

      {showKeyForm ? keyForm(state) : null}

      {state.hasKey ? (
        <Stack gap="md">
          {state.accounts.length > 0 ? (
            <Stack gap="sm">{state.accounts.map((account) => accountBox(account, now))}</Stack>
          ) : state.status.kind === 'ok' ? (
            <EmptyState
              icon="gauge"
              title="No accounts"
              description="The server lists no credentials. Accounts you sign in to in CLIProxyAPI appear here."
            />
          ) : state.status.message === null ? (
            <EmptyState icon="gauge" title="Not read yet" description="The quota of every account appears after the first poll." />
          ) : null}
          {state.omitted > 0 ? (
            <Text muted size="xs">
              {`${state.omitted} more ${state.omitted === 1 ? 'account is' : 'accounts are'} not shown.`}
            </Text>
          ) : null}
          <Text muted size="xs">
            {state.lastPollAt ? 'Last poll ' : 'Not polled yet'}
            {state.lastPollAt ? <RelativeTime at={state.lastPollAt} format="short" /> : null}
            {` · every ${formatInterval(state.pollSeconds)}`}
            {state.polling ? ' · polling now' : ''}
          </Text>
          <Row gap="xs" wrap>
            <Button icon="refresh" disabled={read(busy) || state.polling} onPress={() => run(() => plugin.request('cpa.refresh'))}>
              Refresh
            </Button>
            <Button variant="ghost" icon="edit" onPress={() => set(editingKey, true)}>
              Change key
            </Button>
            <Button
              variant="ghost"
              tone="danger"
              icon="delete"
              tooltip="Deletes the stored management key from this computer."
              disabled={read(busy)}
              onPress={() => run(() => plugin.request('cpa.clearKey'))}
            >
              Forget key
            </Button>
          </Row>
        </Stack>
      ) : null}
    </Stack>
  )
}

const formatInterval = (seconds: number) =>
  seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} s`
