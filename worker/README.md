# Telepathy Worker (v2)

The Telegram community bot on Cloudflare Workers + D1, free plan. Deploy with
[`../docs/DEPLOY_CLOUDFLARE.md`](../docs/DEPLOY_CLOUDFLARE.md).

```bash
npm ci
npm run typecheck
npm test                     # runs inside workerd with a local D1 (Miniflare)
npm run dev                  # local server; put secrets in .dev.vars (see .dev.vars.example)
npm run import -- result.json  # Telegram Desktop export -> D1 SQL files
```

`npm ci` relies on `.npmrc` (`legacy-peer-deps=true`) to work around an npm peer-resolution bug
with the Cloudflare test plugin.
