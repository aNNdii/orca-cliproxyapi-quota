# CLIProxyAPI Quota for Orca

An Orca plugin that shows the remaining subscription quota of every account behind your
[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) server, the way Claude Code's `/usage`
does: for each rate-limit window a "% used" bar and when the window resets. It lives in a
right-sidebar panel and in the status bar.

## What it shows

- **Panel:** one box per account: provider, e-mail (or label, or credential name) and plan, then one
  row per window with a progress bar, "% used" and "resets 14:20" (local time; a weekday or date
  when it is further away), plus when the account was last read successfully. When a read fails,
  the account shows why (for example "rejected the account's token (upstream 401)") and keeps its
  last good numbers; the other accounts are not affected. An account a poll did not get to (see
  [Use](#use)) keeps its numbers too and says "Not read this poll".
- **Status bar:** while the last poll read the server, the tightest window across all enabled
  accounts, for example `Claude 5h 62% · 14:20`: neutral below 80 % used, warning from 80 %,
  danger from 95 % or when a limit is reached. Otherwise it shows the status instead of old
  numbers: `CPA: set up` (no URL or key), `CPA: connecting` (a key was just saved),
  `CPA: key refused` (danger) or `CPA: error` (warning). The tooltip starts with the problem, if
  there is one, then lists as many accounts with their windows as fit, then `+N more in the
  panel`. Pressing it runs **CLIProxyAPI: Show quota**, which lists every account with its windows
  and reset times.

| Provider | Windows | Plan |
| --- | --- | --- |
| Claude (Pro, Max, Team, Free) | 5h, 7d, the per-model weekly windows the account has (Opus, Sonnet, ...), and 7d Fable (from `limits[]`, else from `iguana_necktie` unless that is a dollar credit pool) | from the account profile, looked up once per account (again only after a lookup that failed) |
| Codex (ChatGPT) | 5h, 7d (or 30d), code review and additional limits | from the usage answer |
| Antigravity | each quota group's buckets, remaining fraction shown as % used: 5h (`5h`, `five-hour`, `five_hour`), 7d (`weekly`, `week`), 1d (`daily`), and any other period as the server names it (for example `Gemini monthly`); a bucket without a period, or two with the same one, are named by the bucket | not shown |

Every account the server lists appears. **Disabled** accounts appear greyed and are not queried.
Accounts of other providers (Gemini CLI, Vertex, Kimi, xAI, ...) appear greyed as "quota not
available" and are not queried. CLIProxyAPI's credential list holds the OAuth and file-based
accounts; API keys from the server's config file are not in it, so they do not appear at all.

## Requirements

- CLIProxyAPI **6.6.63 or later** (the first release with the management `api-call`). On 8.0.0 and
  later the plugin uses `/v8/management/credentials` and `/v8/management/requests/api-call`; on
  older servers it falls back to `/v0/management/auth-files` and `/v0/management/api-call`, and
  remembers which one works.
- Management enabled: `management.secret-key` set (`remote-management.secret-key` before v8).
- For a server on another machine: `management.allow-remote: true` (default `false`).
- Orca 1.4.248 or later.

Usage statistics on the server are not needed; the plugin no longer reads the usage queue.

## Install

From Git, pinned to a release:

```sh
orca plugin install https://github.com/aNNdii/orca-cliproxyapi-quota#v0.2.0
```

The plugin runs its own worker, so this first exits with `approval_required` and prints what the
plugin would be granted, its publisher and repository, and an `--approve` fingerprint. Check it,
then run the same command with `--approve <fingerprint>`.

From a checkout: Settings → Plugins → Install → Local folder, or `orca plugin dev watch .` while
developing.

Upgrading from 0.1: version 0.1 counted tokens and was published as `cliproxyapi-usage` from
`aNNdii/orca-cliproxyapi-usage`. This plugin replaces it under a new id, so Orca installs it next to
the old one: uninstall **CLIProxyAPI Usage**, then set the URL and enter the management key again.

## Use

1. Settings → Plugins → CLIProxyAPI Quota: set **CLIProxyAPI URL** to your server, for example
   `https://cliproxy.example.com` (a pasted `/v1` or `/v8/management` is dropped).
2. Open the **CLIProxyAPI** panel in the right sidebar and enter the management key.

The worker reads every account every **Poll interval** (300 seconds by default, 60 to 3600), three
accounts at a time, one poll at a time. A request for the credential list may take 20 seconds; an
api-call may take 70 seconds, because CLIProxyAPI waits up to 60 seconds for the provider. One
account read sends at most three api-calls (Antigravity's three hosts, or Claude's usage and plan),
so it takes at most 3.5 minutes. A poll has a deadline: its interval, at most 5 minutes, but never less than 4 minutes,
so the slowest account read fits in it. At the deadline the poll starts no new account reads; the
reads already running finish, the poll shows what it read, and the accounts it did not get to keep
their last numbers, say "Not read this poll" and are read first in the next poll. If the credential
list itself is still pending at the deadline, the poll fails.

**Refresh** in the panel starts a poll at once, and the panel shows the result when the poll ends;
the command **CLIProxyAPI: Refresh quota now** waits for it. During a poll that no refresh started
(the timer's, or one after a settings change), a refresh queues one more poll right after it,
shared by every refresh in the meantime; during a poll that a refresh started, it joins that one.
Some accounts rest for a while, and the account says when it is asked again:

- After a provider answers 429 (too many requests), also to Claude's plan lookup, the account is
  not asked for 15 minutes, not even by a refresh.
- After a provider refuses the account (upstream 401 or 403), it is not asked for 30 minutes by
  the timer. A refresh asks it anyway, for example right after you signed in to it again.

A rest holds even when the poll that learnt it failed as a whole later on.

**Forget key** in the panel deletes the stored management key and everything read with it.

## Security

- **The management key is full control of your CLIProxyAPI server.** Whoever has it can read and
  change the server's config and its stored provider credentials, and make the server send any
  request upstream with any stored account token. Treat it like a root password.
- **The plugin sends only fixed quota requests through api-call.** CLIProxyAPI's api-call sends a
  request of the caller's choosing with an account's token, and puts the token in on the server
  (the plugin writes `Authorization: Bearer $TOKEN$` and never sees the token). The plugin has a
  hard-coded allowlist and refuses to send anything else:
  - `GET https://api.anthropic.com/api/oauth/usage` and `GET https://api.anthropic.com/api/oauth/profile` (Claude)
  - `GET https://chatgpt.com/backend-api/wham/usage` (Codex)
  - `POST https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary`, and the
    same path on `daily-cloudcode-pa.sandbox.googleapis.com` and `cloudcode-pa.googleapis.com`
    (Antigravity)

  It never calls endpoints that spend reset credits or grants, reset cooldowns, or download
  credential files. Only two values from the server's credential list go into an upstream request: the
  Codex account id (a header, letters, digits and `-` only) and the Antigravity project id (the
  request body, letters, digits and `._:-` only). A value that does not match is dropped.
- **The key itself is checked.** Only keys of printable ASCII characters without spaces, at most
  512 of them, are saved, so a key can never break or extend the `Authorization` header.
- **Honest User-Agent.** Upstream quota requests carry `User-Agent: orca-cliproxyapi-quota/0.2.0`;
  the plugin does not pretend to be Claude Code, Codex or Antigravity. If a provider refuses the
  request for that reason, the account shows the refusal (for example "upstream 403").
- **Unverified:** whether Anthropic, OpenAI or Google mind periodic quota checks from a
  non-official client, and whether these checks count against anything. They are account metadata
  requests, not model requests; the plugin keeps them infrequent (every 5 minutes by default) and
  rests an account after a 429, 401 or 403 (see [Use](#use)). Use a longer poll interval if in
  doubt.
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
- **A refused key is not sent again.** After a 401 from the management API itself the plugin marks
  the stored key refused and sends nothing until you save a key, even across restarts, because
  CLIProxyAPI bans an IP address for about 30 minutes after five failed attempts. The refusal is
  remembered in memory first, so if storing it fails (for example, a locked keychain) the key is
  still not sent again while the worker runs; it would be sent once more after a restart. When the
  server reports such a ban, the plugin sends nothing to that server until the time the server
  names ("Try again in 29m59s"), or for 30 minutes when it names none; this pause is kept in
  memory, so a worker restart ends it. A 401 from a provider (an expired account token, relayed
  inside an api-call answer) only concerns that account.
- **What is kept, and where:**
  - Orca's encrypted plugin secrets: the management key, the origin it is for, and whether the server
    refused it.
  - In memory only: the last good windows, plan and notes per account, and when it may be asked
    again. Nothing about accounts is written to disk.
  - Never passed on: account tokens, request headers, upstream answer bodies.
- **Everything taken from the server is checked and capped.** An answer larger than 8 MiB is
  refused: at once when its `Content-Length` says so, otherwise the plugin stops reading it at
  that size, so a hostile server cannot fill the worker's memory. An upstream body relayed by
  api-call may be at most 256 Ki characters. Text is trimmed, stripped of control characters and
  capped; at most 100 accounts and 12 windows per account are kept; numbers must be finite and
  percent is clamped to 0 to 100. What the worker sends the panel stays below 200 KiB (Orca
  refuses panel messages over 256 KiB): when a listing would be larger, account names, labels and
  messages are cut short first, then the last accounts are left out and the panel says how many
  more there are.
- **The key stays in the worker.** The panel, the status bar and commands get only whether a key is
  stored. Messages and the plugin log never quote a network error's own text, which could contain
  request headers; they say only which server could not be reached. The server's own error text is
  shown with the key and any `Bearer` token replaced by `***`, whatever the key's length; this
  happens on the whole text, after control characters are removed and before it is cut to 200
  characters, so no part of the key shows. (A very short key also hides ordinary words that
  contain it.)

## Develop

```sh
orca plugin types .        # typings into .orca/types
orca plugin validate .
orca plugin test .         # src/*.test.ts(x) in Node, with a stand-in server and stub upstreams
orca plugin check .        # renders the panel in each src/panel.check.ts scenario
pnpm dlx --package typescript@5.9 tsc -p .
orca plugin dev watch .    # load into the running Orca desktop app
```

| File | Role |
| --- | --- |
| `src/providers.ts` | The provider table: credential entry fields, allowlisted requests, parsing upstream answers into windows, what each upstream status means, `USER_AGENT` |
| `src/accounts.ts` | Reading the credential list into accounts |
| `src/client.ts` | Management API client: v8/v0, timeouts, size caps, api-call, URL rules, which failures concern every account, the ban rule |
| `src/keystore.ts` | The stored management key: its secret format, which keys can be saved, refusals |
| `src/collector.ts` | Poll timer and deadline, the ban, account reads and rests, publishing |
| `src/format.ts` | How percent, reset times, tones, statuses, messages, the status bar, its tooltip and the summary read |
| `src/untrusted.ts` | Small readers for untrusted JSON |
| `src/worker.ts` | Connects Orca's panel requests and commands to the collector |
| `src/panel.tsx` | Components panel |
| `src/protocol.ts` | Panel and worker contract, and the size budget of the state |
| `src/version.ts` | The plugin's version |
| `src/fixtures.ts` | Test data, a sample panel state and a stand-in CLIProxyAPI server, for the tests and checks only |

## License

MIT
