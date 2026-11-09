# CLIProxyAPI Usage for Orca

An Orca plugin that shows how many requests and tokens go through your
[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) server: today, the last 7 and the last
30 days, per model and per account, in a right-sidebar panel and in the status bar.

Since CLIProxyAPI 6.10 the server keeps no usage statistics of its own. It publishes one record per
request to a short-lived usage queue instead. The plugin's worker reads that queue every few
seconds, counts each record into the plugin's storage and keeps the counts across restarts.

## What it needs on the server

Config names are the v8 paths; names on configs before v8 are in parentheses.

- Management enabled: `management.secret-key` set (`remote-management.secret-key`).
- For a server on another machine: `management.allow-remote: true` (default `false`).
- Usage publishing on: `observability.usage.usage-statistics-enabled: true`
  (`usage-statistics-enabled`). The default is off. The panel warns when the server reports it off,
  or when a v8 server's config does not set it.
- Queue retention longer than the poll interval: records expire after
  `observability.usage.redis-usage-queue-retention-seconds` (`redis-usage-queue-retention-seconds`),
  60 seconds by default, at most 3600. The plugin polls every 15 seconds by default.

The plugin uses the v8 management API (`/v8/management/observability/usage/queue`) and falls back
to the v0 path (`/v0/management/usage-queue`) on older servers.

## Install

From Git, pinned to a release:

```sh
orca plugin install https://github.com/aNNdii/orca-cliproxyapi-usage#v0.1.0
```

The plugin runs its own worker, so this first exits with `approval_required` and prints what the
plugin would be granted, its publisher and repository, and an `--approve` fingerprint. Check it,
then run the same command with `--approve <fingerprint>`.

From a checkout: Settings → Plugins → Install → Local folder, or `orca plugin dev watch .` while
developing.

## Use

1. Settings → Plugins → CLIProxyAPI Usage: set **CLIProxyAPI URL** to your server, for example
   `https://cliproxy.example.com` (a pasted `/v1` or `/v8/management` is dropped).
2. Open the **CLIProxyAPI** panel in the right sidebar and enter the management key.

The status bar item shows today's tokens; pressing it shows a summary. The command palette has
**CLIProxyAPI: Show today's usage** and **CLIProxyAPI: Refresh usage now**. **Reset counts** in the
panel asks for confirmation before it deletes the counted usage.

## Security

- **The management key is full control of your CLIProxyAPI server.** Whoever has it can read and
  change the server's config and its stored provider credentials, and make the server send requests
  upstream. Treat it like a root password.
- **The plugin runs as a `trusted-worker`.** Its worker is not sandboxed: it runs with your user's
  permissions on the computer running Orca, which is why Orca asks you to approve it. Install it only
  from a source you trust. It has no dependencies; the code is the files in `src/`.
- **Use https, or an SSH tunnel.** The URL must use `https://`. Plain `http://` is accepted only for
  this computer (`localhost`, `127.x.x.x`, `[::1]`), because the key would otherwise cross the
  network unencrypted. For a remote server without TLS, forward its port over SSH (for example
  `ssh -L 8317:127.0.0.1:8317 your-server`) and use `http://127.0.0.1:8317`.
- **The key is bound to the server it was saved for.** The plugin stores the key together with the
  origin (scheme, host and port) of the URL at that moment, and sends it only to that origin. If you
  change the URL to another server, polling stops until you enter that server's key. The plugin
  refuses redirects, so the key never follows one elsewhere.
- **A refused key is not sent again.** After a 401 the plugin marks the stored key refused and sends
  nothing until you save a key, even across restarts, because CLIProxyAPI bans an IP address for
  about 30 minutes after five failed attempts. When the server reports such a ban, the plugin sends
  nothing to that server for 30 minutes; this pause is kept in memory, so a worker restart ends it.
- **What is stored, and where:**
  - Orca's encrypted plugin secrets: the management key, the origin it is for, and whether the server
    refused it.
  - Plugin storage (`usage`): per-day totals of requests, failures, tokens and latency by model name
    (with its provider) and by account label (the `source` field of the record, usually the account
    e-mail), plus when counting started and the time of the newest record. At most 200 model and 200
    account names are kept per day; further names are counted under `(other)`.
  - Never stored: client API keys, request IDs, response headers or anything from prompts and
    answers. The key never reaches the panel, the status bar, commands or the plugin log.

## Limits

- **Reading the Management usage queue removes the records.** Run no other consumer of the same
  queue (a usage service such as CPA-Manager, another dashboard, or this plugin on a second
  computer) at the same time, or each one sees only part of the traffic. On servers before v8 the
  Redis-compatible RESP endpoint (`LPOP`/`SUBSCRIBE`) is another consumer of that queue; v8 servers
  disable that local RESP output.
- Requests are counted only while Orca runs with the plugin enabled. Records that expire on the
  server while Orca is closed are lost.
- Counts are per calendar day in the local time zone of the computer running Orca. **Days of history
  to keep** (31 by default, today included) limits what the ranges can show; the panel says so when
  the selected range is longer.
- One poll reads at most 20 pages of 500 records; the rest waits for the next poll.

## Develop

```sh
orca plugin types .        # typings into .orca/types
orca plugin validate .
orca plugin test .         # src/*.test.ts(x) in Node, with a stand-in server
orca plugin check .        # renders the panel in each src/panel.check.ts scenario
pnpm dlx --package typescript@5.9 tsc -p .
orca plugin dev watch .    # load into the running Orca desktop app
```

| File | Role |
| --- | --- |
| `src/usage.ts` | Pure counting: records to per-day totals and the range views |
| `src/client.ts` | Management API client: API version, statistics switch, URL rules, errors |
| `src/collector.ts` | Poll timer, the key and what the server said about it, storage, status bar |
| `src/worker.ts` | Connects Orca's panel requests, commands and settings changes to the collector |
| `src/panel.tsx` | Components panel |
| `src/protocol.ts` | Panel and worker contract |

## License

MIT
