// The plugin worker. Orca keeps it running while the plugin is enabled, because the plugin owns a
// status bar item, so the collector polls the CLIProxyAPI usage queue on its own. This file only
// connects Orca's panel requests, commands and settings changes to the collector.
import type { OrcaWorkerApi } from 'orca/worker'
import { Collector } from './collector'

let collector: Collector | null = null

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  const current = await Collector.open(orca, (url, init) => fetch(url, init))
  collector = current

  orca.panels.handle('cpa.state', () => current.state())
  orca.panels.handle('cpa.refresh', async () => {
    await current.refresh()
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
  orca.panels.handle('cpa.reset', async () => {
    await current.reset()
    return current.state()
  })

  orca.commands.register('cliproxyapi.summary', () => current.summary())
  orca.commands.register('cliproxyapi.refresh', async () => {
    await current.refresh()
    return current.summary()
  })

  orca.settings.onDidChange(() => void current.reconfigure())
  void current.refresh()
}

export async function deactivate(): Promise<void> {
  const current = collector
  collector = null
  await current?.stop()
}
