// `orca plugin check` renders the panel once per scenario, with the worker on a fresh host.
// No scenario reaches a server: in each one the worker refuses to send the key before any request
// (no URL, plain http to a remote host, no key, a key saved for another origin, a refused key).
// `accounts` answers the panel's `cpa.state` with the sample state instead of the worker's.
import { defineCheck } from 'orca/testing'
import { ORIGIN, sampleState } from './fixtures'
import { encodeKey, KEY_SECRET } from './keystore'

const key = (origin: string, refused = false) => encodeKey({ origin, key: 'example-key', refused })

export default defineCheck({
  notConfigured: { settings: { baseUrl: '', pollSeconds: 300 } },
  remoteHttp: { settings: { baseUrl: 'http://cpa.example.com', pollSeconds: 300 } },
  noKey: { settings: { baseUrl: 'http://127.0.0.1:9', pollSeconds: 300 } },
  keyForOtherServer: {
    settings: { baseUrl: ORIGIN, pollSeconds: 300 },
    secrets: { [KEY_SECRET]: key('https://other.example.com') }
  },
  keyRefused: {
    settings: { baseUrl: ORIGIN, pollSeconds: 300 },
    secrets: { [KEY_SECRET]: key(ORIGIN, true) }
  },
  accounts: {
    settings: { baseUrl: '', pollSeconds: 300 },
    requests: { 'cpa.state': sampleState(Date.now()) },
    theme: 'light'
  }
})
