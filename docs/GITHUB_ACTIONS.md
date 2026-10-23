# GitHub Actions: work the free Worker can't do

The Worker gets 10 ms of CPU per request and 50 subrequests. GitHub Actions runners get minutes
of CPU, gigabytes of RAM, and Python. Actions are free on standard runners for public
repositories; private repositories on the Free plan get about 2,000 minutes/month
([GitHub billing docs](https://docs.github.com/en/actions/reference/usage-limits-billing-and-administration);
the minutes figure is from secondary sources such as
[cicdcalculator](https://cicdcalculator.com/github-actions-free-tier)). A single job can run for
up to 6 hours (per a [community discussion](https://github.com/orgs/community/discussions/184661)).

**This repository is public.** Workflow logs, and artifacts for anyone with read access, are
visible to the world. So these workflows log **counts only**, and anything containing community
data is either encrypted before upload or never written out.

## What moves to Actions

| Job | Why not in the Worker | Community data on GitHub? | Default | Workflow |
|---|---|---|---|---|
| **Deploy** (test → migrate D1 → deploy) | needs your Cloudflare token; repeatable releases | no | off (`CLOUDFLARE_DEPLOY`) | `deploy-worker.yml` |
| **Encrypted D1 backup**, weekly, kept off Cloudflare | Workers can't export their own database | yes, but **encrypted with your age key first**; plaintext never leaves the runner | off (`D1_BACKUP`) | `d1-backup.yml` |
| **Queue drain**: calls `/admin/cron` 5× per hour | one 5-min cron run sends ~30 digests; big communities need more passes | no (responses are counts) | on once `WORKER_URL` is set | `worker-jobs.yml` → `maintenance` |
| **PDF / DOCX / PPTX parsing** | parsing a PDF can take seconds of CPU; the Worker only parses text files ≤ 512 KB | **yes: files pass through GitHub runners** (not logged, not stored) | **on**: owner approved 2026-10-23 (`OFFLOAD_DOCUMENTS`) | `worker-jobs.yml` → `documents` |

## What Actions can't fix

- **Live semantic search.** Actions could compute message embeddings in batches, but every
  `/ask` would also need the *question* embedded within seconds. A free Worker can't do that
  (CPU limit), and a hosted embedding API would send text to a third party (C03). Scheduled jobs
  can't answer live queries, so lexical + fuzzy search stays the v2 search.
- **Real-time work.** Scheduled workflows are best-effort and can start late. Anything a user
  waits for stays in the Worker.
- **OCR / speech-to-text.** Possible on a runner (Tesseract, whisper.cpp), but it's heavy and
  sends recordings and scans through GitHub. Deferred until the owner approves (P07-03/04).

## How document offload works

1. A member posts `plan.pdf` in an enabled group. The Worker stores the message and, if
   `OFFLOAD_DOCUMENTS` is `"true"` in `wrangler.jsonc`, adds the file to `doc_queue`.
2. Hourly, `worker-jobs.yml` runs `python -m telepathy.ops.offload`:
   `GET /admin/docs/pending` → Telegram `getFile` + download → v1 parsers (pypdf, python-docx,
   python-pptx) → `POST /admin/docs/result` with text chunks (page / slide locators kept).
3. The Worker stores the chunks only if the message is still live and the group still enabled
   (C06). Scanned PDFs come back as `skipped` (`needs_ocr`). Failures retry up to 3 times.
4. Logs show only `{"done": n, "skipped": n, "failed": n, "chunks": n}`.

## Setup

Repository → Settings → Secrets and variables → Actions:

| Name | Type | Used by | Value |
|---|---|---|---|
| `CLOUDFLARE_API_TOKEN` | secret | deploy, backup | API token with *Workers Scripts: Edit* and *D1: Edit* |
| `CLOUDFLARE_ACCOUNT_ID` | secret | deploy, backup | from the Cloudflare dashboard |
| `ADMIN_TOKEN` | secret | worker-jobs | same value as the Worker's `ADMIN_TOKEN` |
| `BOT_TOKEN` | secret | documents | same value as the Worker's `BOT_TOKEN` |
| `D1_DATABASE_ID` | variable | deploy, backup | from `wrangler d1 create` |
| `WORKER_URL` | variable | worker-jobs | `https://telepathy.<you>.workers.dev` |
| `CLOUDFLARE_DEPLOY` | variable | deploy | `true` to deploy on merge |
| `D1_BACKUP` | variable | backup | `true` |
| `AGE_RECIPIENT` | variable | backup | your age **public** key (`age-keygen` → `age1…`) |
| `OFFLOAD_DOCUMENTS` | variable | documents | `true` (owner approved 2026-10-23). The Worker side is already `"true"` in `wrangler.jsonc`; set it to `"false"` there to stop queueing |

Create an environment named `production` (Settings → Environments). Add yourself as a required
reviewer there if you want to approve each deploy.

Restore a backup: download the artifact, then
`age -d -i key.txt telepathy-….sql.age > backup.sql` and
`npx wrangler d1 execute <db> --remote --file backup.sql` (see `DEPLOY_CLOUDFLARE.md` §6).

Scheduled workflows in a public repository may be paused by GitHub after a long period without
repository activity. Check the Actions tab occasionally, or re-enable the workflow there.
