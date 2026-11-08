# Telepathy Worker (v2)

The Telegram community bot on Cloudflare Workers + D1, free plan. Deploy with
[`../docs/DEPLOY_CLOUDFLARE.md`](../docs/DEPLOY_CLOUDFLARE.md).

```bash
npm ci
npm run typecheck
npm test                     # runs inside workerd with a local D1 (Miniflare)
npm run dev                  # local server; put secrets in .dev.vars (see .dev.vars.example)
npm run import -- result.json  # Telegram Desktop export -> D1 SQL files
npm run build:history          # browser history importer + standalone /export Mini App
```

The standalone `/export` Mini App exports any Telegram group/channel the signed-in user can read to
JSON in a ZIP, with an optional direct tmpfiles upload. It is separate from the community database;
see [`../docs/CHAT_EXPORT.md`](../docs/CHAT_EXPORT.md).

`npm ci` relies on `.npmrc` (`legacy-peer-deps=true`) to work around an npm peer-resolution bug
with the Cloudflare test plugin.
