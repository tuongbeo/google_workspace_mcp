# cloudflare-worker

Cloudflare Worker implementation of the Google Workspace MCP server, deployed
as a single `office` worker with its own `McpAgent` Durable Object class:

| Worker | Config | Entry point | DO class | Deploy |
|---|---|---|---|---|
| `office` | [`wrangler.office.jsonc`](./wrangler.office.jsonc) | `src/workers/office.ts` | `OfficeAgent` | `npm run deploy` |

It talks to `OAUTH_KV`, `TOKENS_KV`, and `CONFIG_KV` namespaces. Google OAuth
tokens are stored under the `office` namespace inside `TOKENS_KV` — see
`makeGetCreds` in `src/google-tokens.ts`.

The worker never talks to Google OAuth directly. It delegates to a separate,
centralized `google-auth` worker (`GOOGLE_AUTH_BASE_URL`) via the flow in
`src/auth/google.ts`: `/authorize` redirects to `google-auth`'s
`/delegate/authorize`, which redirects back to `/callback-delegate` with a
one-time code that's exchanged server-to-server for `{sub, email}`. Token
refresh is likewise centralized — see `getValidAccessToken` in
`src/google-tokens.ts`, which calls `google-auth`'s `POST /delegate/refresh`
rather than holding its own Google OAuth client secret.

## Commands

```bash
npm run dev            # wrangler dev
npm run type-check      # tsc --noEmit
npm test                 # vitest run
npm run deploy           # deploy the office worker
```

CI (`.github/workflows/ci.yml`) runs `type-check` and `test` on every PR.
