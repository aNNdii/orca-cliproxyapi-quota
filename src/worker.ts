// The plugin worker. Orca keeps it running while the plugin is enabled, because the plugin owns a
// status bar item, so the collector polls the quota of every account on its own. This file only
// connects Orca's panel requests and commands to the collector, which follows settings itself.
import type { OrcaWorkerApi } from 'orca/worker'
import type { FetchLike } from './client'
import { type Clock, Collector, systemClock } from './collector'

let collector: Collector | null = null

/** `activate` with the network and the clock given, so tests can stand in for both. */
export function activateWith(fetch: FetchLike, clock: Clock = systemClock) {
  return async function activate(orca: OrcaWorkerApi): Promise<void> {
    const current = new Collector(orca, fetch, clock)
    collector = current

    orca.panels.handle('cpa.state', () => current.state())
    // A poll can take minutes, longer than a panel waits for an answer.
    orca.panels.handle('cpa.refresh', () => {
      void current.refresh({ manual: true })
      return current.state()
    })
    orca.panels.handle('cpa.setKey', async ({ key }) => {
      await current.saveKey(typeof key === 'string' ? key : '')
      return current.state()
    })
    orca.panels.handle('cpa.clearKey', async () => {
      await current.clearKey()
      return current.state()
    })

    orca.commands.register('cliproxyapi.quota', () => current.summary())
    orca.commands.register('cliproxyapi.refresh', async () => {
      await current.refresh({ manual: true })
      return current.summary()
    })

    await current.start()
  }
}

export default activateWith((url, init) => fetch(url, init))

export async function deactivate(): Promise<void> {
  const current = collector
  collector = null
  await current?.stop()
}
