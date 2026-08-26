# aistudio-pool

OpenAI-compatible gateway over the **Google AI Studio web UI**, with multi-account
pooling, per-account parked Chrome oracles, and a mobile-first web dashboard.

Reverse-engineered wire protocol lives in [`../ai-studio-re/PROTOCOL.md`](../ai-studio-re/PROTOCOL.md).

## How it works

```
client ──▶ POST /v1/chat/completions        (OpenAI-compatible, SSE or JSON)
                │
           ▶ AccountPool                    (LRU pick, busy/cooldown states)
                │
           ▶ AisDriver (one per account)    (dedicated Chrome + persistent Google login)
                │  1. navigate to new_chat?model=<model>
                │  2. clear leftover tool pills/popups
                │  3. inject prompt via Angular-native input events
                │  4. AI Studio's own JS mints the BotGuard blob and POSTs GenerateContent
                │  5. capture the response via CDP Network events, parse frames
                ▼
           {thinking, text, usage chunks} ──▶ OpenAI SSE (reasoning_content + content)
```

Why a browser per account: the request contains a **payload-bound BotGuard attestation
blob** (`!X…`) that only AI Studio's page JS can mint (verified: verbatim replays succeed
from raw Python, any modified payload → 403). The browser is an oracle; everything else
(pooling, API, dashboard) is plain Node.

## Run

```bash
npm install
npm run smoke                          # attach :9222, one test chat
ATTACH_PORT=9222 PORT=8787 npm start   # serve API + dashboard
```

- `ATTACH_PORT` — attach to an already-running Chrome with `--remote-debugging-port`
  (becomes account `main`, or `$ATTACH_NAME`).
- Without it, each dir under `accounts/` is launched as its own Chrome profile.

## API

| Endpoint | Description |
|---|---|
| `POST /v1/chat/completions` | OpenAI-compatible; `stream: true` → SSE with `reasoning_content` (thinking) + `content` |
| `GET /v1/models` | model list |
| `GET /api/accounts` | account states + stats |
| `POST /api/accounts {"name":"acc2"}` | launch headed Chrome for manual Google sign-in |
| `POST /api/accounts/:name/refresh` | re-check login → flip to idle |
| `POST /api/accounts/:name/pause` | pause/resume |
| `DELETE /api/accounts/:name` | close browser, drop from pool (profile kept) |
| `GET /api/stats` · `GET /api/log` | aggregate stats · last 300 requests |
| `/` | dashboard (mobile-first: accounts / playground / log) |

`API_KEYS` env (comma-separated) enables bearer auth on `/v1/*`.

## Env

`PORT` `ATTACH_PORT` `ATTACH_NAME` `HEADED=1` (run account browsers headed)
`DEFAULT_MODEL` `API_KEYS` `ACCOUNTS_DIR` `CHROME_PATH` `CHAT_TIMEOUT_MS`

## Adding an account

`POST /api/accounts {"name":"acc2"}` → a headed Chrome window opens → sign into Google
in it → `POST /api/accounts/acc2/refresh` → state flips to `idle`. Profile (cookies)
persists under `accounts/acc2/profile`, so restarts stay logged in.

## Quota handling

Google RPC errors are surfaced: code 8 (`RESOURCE_EXHAUSTED`) → account goes to
`cooldown` for 10 min and the pool rotates to the next one; code 7 → `logged_out`/error.
Free-tier preview models (e.g. `gemini-3.1-pro-preview`) have tight daily limits —
flash models have much higher RPM/RPD.
