// `orca plugin check` renders the panel once per scenario, with the worker on a fresh host.
// No scenario reaches a server: in each one the worker refuses to send the key before any request
// (no URL, plain http to a remote host, no key, a key saved for another origin, a refused key).
import { defineCheck } from 'orca/testing'

const key = (origin: string, refused = false) =>
  JSON.stringify(refused ? { origin, key: 'example-key', refused: true } : { origin, key: 'example-key' })

export default defineCheck({
  notConfigured: { settings: { baseUrl: '', pollSeconds: 300 } },
  remoteHttp: { settings: { baseUrl: 'http://cpa.example.com', pollSeconds: 300 } },
  noKey: { settings: { baseUrl: 'http://127.0.0.1:9', pollSeconds: 300 } },
  keyForOtherServer: {
    settings: { baseUrl: 'https://cpa.example.com', pollSeconds: 300 },
    secrets: { managementKey: key('https://other.example.com') }
  },
  keyRefused: {
    settings: { baseUrl: 'https://cpa.example.com', pollSeconds: 300 },
    secrets: { managementKey: key('https://cpa.example.com', true) }
  },
  shortRetention: {
    settings: { baseUrl: 'https://cpa.example.com', pollSeconds: 300, retentionDays: 1 },
    secrets: { managementKey: key('https://cpa.example.com', true) },
    persisted: { plugin: { range: 'days30' } }
  }
})
