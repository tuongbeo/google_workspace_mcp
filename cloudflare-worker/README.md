# cloudflare-worker

Cloudflare Worker implementation of the Google Workspace MCP server. Two separate
workers are deployed from this package, each with its own Wrangler config and
its own `McpAgent` Durable Object class:

| Worker | Config | Entry point | DO class | Deploy |
|---|---|---|---|---|
| `workspace` (default) | [`wrangler.jsonc`](./wrangler.jsonc) | `src/index.ts` | `GoogleWorkspaceAgent` | `npm run deploy` |
| `office` | [`wrangler.office.jsonc`](./wrangler.office.jsonc) | `src/workers/office.ts` | `OfficeAgent` | `npm run deploy:office` |

Both workers share the same `OAUTH_KV`, `TOKENS_KV`, and `CONFIG_KV` namespaces.
Google OAuth tokens are stored per-namespace (`office`, `workspace`, ...) inside
`TOKENS_KV` so the two workers don't collide — see `makeGetCreds` in
`src/google-tokens.ts`.

Neither worker talks to Google OAuth directly. Both delegate to a separate,
centralized `google-auth` worker (`GOOGLE_AUTH_BASE_URL`) via the flow in
`src/auth/google.ts`: `/authorize` redirects to `google-auth`'s
`/delegate/authorize`, which redirects back to `/callback-delegate` with a
one-time code that's exchanged server-to-server for `{sub, email}`.

## Commands

```bash
npm run dev            # wrangler dev (workspace worker, default config)
npm run type-check      # tsc --noEmit
npm test                 # vitest run
npm run deploy           # deploy the workspace worker
npm run deploy:office    # deploy the office worker
```

CI (`.github/workflows/ci.yml`) runs `type-check` and `test` on every PR.
