# Security Policy

## Reporting Security Issues

**Please do not report security vulnerabilities through public GitHub issues, discussions, or pull requests.**

Instead, please email us at **manhtuongdz@gmail.com**

Please include as much of the following information as you can to help us better understand and resolve the issue:

- The type of issue (e.g., authentication bypass, credential exposure, command injection, etc.)
- Full paths of source file(s) related to the manifestation of the issue
- The location of the affected source code (tag/branch/commit or direct URL)
- Any special configuration required to reproduce the issue
- Step-by-step instructions to reproduce the issue
- Proof-of-concept or exploit code (if possible)
- Impact of the issue, including how an attacker might exploit the issue

This information will help us triage your report more quickly.

## Supported Versions

Workspace Lens is a continuously-deployed hosted service (Cloudflare Workers), not a
versioned package you install — there's no self-hosted release to patch separately.
Only the currently deployed version of the public MCP service at `office.lens.io.vn`
is supported; security fixes are deployed as soon as they're merged rather than
backported to older releases.

If you're running your own fork or deployment of this codebase, you are responsible
for keeping it up to date with upstream fixes.

## Security Considerations

Workspace Lens stores your Google OAuth tokens on your behalf so you don't have to —
that's the trade-off of the "no configuration" model. Specifically:

- **Shared tier**: Google access/refresh tokens are stored server-side in Cloudflare
  KV, scoped per-user by Google account ID, and never exposed to the client. OAuth
  is delegated through a centralized auth worker rather than handled per-deployment.
- **BYOC tier**: if you [register your own Google Cloud OAuth app](https://auth.lens.io.vn/byoc-register),
  your tokens are stored under your own tenant, isolated from the shared tier's
  token storage.
- Only request the OAuth scopes you actually need — the connector already limits
  scopes per Google service; don't grant broader access than required.
- If you fork or self-host this codebase, treat `TOKENS_KV` and `OAUTH_KV` as
  sensitive: never commit credentials, use Wrangler secrets (not `vars`) for
  `GOOGLE_OAUTH_CLIENT_SECRET` and `GOOGLE_AUTH_SERVICE_TOKEN`, and rotate them if
  ever exposed.

For what data is collected and how to request deletion, see the
[Privacy Policy](https://workspace.lens.io.vn/privacy).

## Preferred Languages

We prefer all communications to be in English.

## Policy

We follow the principle of responsible disclosure. We will make every effort to address security issues in a timely manner and will coordinate with reporters to understand and resolve issues before public disclosure.