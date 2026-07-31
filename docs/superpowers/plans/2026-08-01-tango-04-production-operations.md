# Tango Phase 4 Implementation Plan: Production Operations

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development for application hardening, superpowers:systematic-debugging for any deployment verification failure, and superpowers:verification-before-completion before the review gate. Execute only after Phase 3 passes Codex review.

**Goal:** `tango.warasugi.com` をDebian 12/13の非特権App/DB LXC、Cloudflare Tunnel、PostgreSQL、継続WALバックアップ、監視・通知で安全に運用できる再現可能な成果物を完成させる。

**Architecture:** App LXCではBun API/SPAとcloudflaredをComposeで動かし、公開ポートを持たない。DB LXCではPostgreSQLをApp LXCの内部アドレスだけへTLS/SCRAMで公開し、pgBackRestを別障害ドメインへ保存する。日次maintenanceはアプリ内タイマーではなくsystemd timerから一回実行型コマンドを起動する。Uptime Kuma、Zabbix、Discordは秘密をリポジトリへ置かず構成手順と検証用成果物を提供する。

**Tech Stack:** Phase 1–3の固定スタック、Docker Engine/Compose v2、`oven/bun:1.3.14-debian`、`postgres:18.4-bookworm`、cloudflared、pgBackRest、PowerShell/Nushellから実行できる検証コマンド。

**Source specification:** [Tango Spaced Repetition Web App Design](../specs/2026-08-01-tango-spaced-repetition-design.md)

---

## Entry Conditions and Change Boundary

- Read `C:\Users\waras\.claude\CLAUDE.md` first and apply it before repository-local instructions.
- Phase 1–3のレビューゲートが通過し、全アプリケーションテストが成功していること。
- 本Phaseはリポジトリ内のコード、Compose、スクリプト、文書、隔離テスト環境だけを変更する。
- Proxmox設定、LXC作成/再起動、OPNsense/AdGuard Home、DNS、Cloudflare Tunnel/WAF、実DB、実バックアップ領域、Uptime Kuma、Zabbix、Discord Webhookには変更を適用しない。実適用は完成レビュー後の別作業とし、対象・目的・リスク・ロールバックを提示して個別承認を得る。
- App/DB LXCはDebian 13を推奨し、Debian 12も起動・health・backup clientまで検証する。特権LXCへの変更を回避し、非特権LXCの `nesting=1,keyctl=1` を候補とするが、Proxmox hostでの変更は自動化しない。
- public originは `https://tango.warasugi.com` のみ。Cloudflare Tunnel以外からAppへ到達できない構成にする。
- DBの唯一のネットワーク利用者はApp LXC。DB LXCの5432をWAN、Cloudflare、一般LANへ公開しない。
- 秘密情報の優先順位は外部Secret Manager/Proxmox secret mount、root-only secret file、環境変数。`.env` はローカル検証のみで `.gitignore` 対象とし、リポジトリには `.env.example` とsecret名だけを置く。

## Required Production Inputs

文書は次の入力名を固定し、値をコミットしない。

| Input | Meaning |
|---|---|
| `APP_LXC_ADDRESS` | App LXCの内部固定IP |
| `DB_LXC_ADDRESS` | DB LXCの内部固定IP |
| `DB_INTERNAL_NAME` | DB証明書SANと接続先。標準 `tango-db.internal` |
| `APP_GIT_SHA` | userがpush済み・承認済みの40桁commit SHA |
| `TANGO_IMAGE` | `tango-web:<APP_GIT_SHA>` のローカルtag。build後image IDも記録 |
| `BUN_BASE_IMAGE` | `oven/bun:1.3.14-debian@sha256:…` |
| `POSTGRES_IMAGE` | `postgres:18.4-bookworm@sha256:…` |
| `CLOUDFLARED_IMAGE` | 検証済みversion+digest |
| `BACKUP_ROOT` | DB LXC本体とは別障害ドメインのmount |
| `TUNNEL_ID` | Cloudflare named tunnel ID |
| `PUBLIC_ORIGIN` | 固定値 `https://tango.warasugi.com` |
| `PRIVACY_CONTACT_URL` | 運営者が指定する非秘密のHTTPS連絡先。productionでは必須 |

Secret file names are also fixed; their values and recovery keys never enter Git:

| Secret file input | Consumer |
|---|---|
| `BETTER_AUTH_SECRET_FILE` | Better Auth signing and native OAuth-token encryption |
| `GUEST_TOKEN_PEPPER_FILE` | guest-cookie token HMAC |
| `AUDIT_IP_HMAC_KEY_FILE` | privacy-preserving IP/rate-limit fingerprints |
| `GOOGLE_CLIENT_SECRET_FILE` / `GITHUB_CLIENT_SECRET_FILE` | Better Auth social providers |
| `TURNSTILE_SECRET_FILE` | guest-start verification |
| `DATABASE_URL_FILE` / `MIGRATOR_DATABASE_URL_FILE` | runtime and deployment migration connections |
| four DB role password files | PostgreSQL bootstrap only |
| `PGBACKREST_REPO_CIPHER_PASS_FILE` | encrypted physical backup repository |
| `LOGICAL_BACKUP_RECIPIENTS_FILE` | public `age` recipients used by DB LXC |
| `LOGICAL_BACKUP_IDENTITY_FILE` | private `age` recovery identity, mounted only for isolated restore |
| named-tunnel credential JSON | cloudflared only |

Production files are root-owned `0600` except the public logical-backup recipients file (`0644`). Container mounts are read-only and limited to the one consumer that needs each file.

Image digestはTask 2の実行日にregistry manifestを照会して `infra/images.lock` へ実値を記録する。digestを推測・仮記入してはならない。digest変更は依存更新として別レビュー対象にする。

## Task Commit Map

各Taskの最終検証成功後、`.gitignore`、status、diff check、Task diff、staged paths、関連テストを確認し、そのTaskのファイルだけを次のmessageでcommitする。ユーザーは2026-08-01にこのTask単位commitを事前承認している。push、deploy、外部設定変更は行わない。

| Task | Commit message |
|---:|---|
| 1 | `feat(security): Web境界と監査ログを強化` |
| 2 | `feat(ops): AppとDBのLXC向けComposeを追加` |
| 3 | `feat(ops): 保持期限maintenanceを追加` |
| 4 | `feat(backup): PostgreSQLのPITRと復旧検証を追加` |
| 5 | `feat(ops): ヘルスチェックと監視資料を追加` |
| 6 | `feat(ops): 配備とロールバック手順を追加` |
| 7 | `test(ops): 本番運用の受入検証とレビュー資料を追加` |

---

### Task 1: Harden HTTP boundaries, rate limits, audit logs, and secret loading

**Files:**

- Create: `apps/api/src/middleware/security-headers.ts`
- Create: `apps/api/src/middleware/security-headers.test.ts`
- Create: `apps/api/src/middleware/csrf.ts`
- Create: `apps/api/src/middleware/csrf.test.ts`
- Create: `apps/api/src/middleware/body-limit.ts`
- Create: `apps/api/src/middleware/rate-limit.ts`
- Create: `apps/api/src/middleware/rate-limit.integration.test.ts`
- Create: `apps/api/src/middleware/audit.ts`
- Create: `apps/api/src/middleware/audit.test.ts`
- Create: `packages/db/src/schema/operations.ts`
- Modify: `packages/db/src/schema/identity.ts`
- Create: `packages/db/migrations/0003_operations_security.sql`
- Create: `packages/db/src/repositories/rate-limit-repository.ts`
- Create: `packages/db/src/repositories/audit-repository.ts`
- Modify: `apps/api/src/env.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `packages/shared/src/errors/app-error.ts`
- Modify: `.gitignore`
- Modify: `.env.example`

**Step 1: Write failing security-header and CSRF tests**

Assert every HTML/API response carries:

- `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`
- `Referrer-Policy: no-referrer`
- `X-Content-Type-Options: nosniff`
- `Permissions-Policy` disabling camera, microphone, geolocation, payment, and USB;
- `Cross-Origin-Opener-Policy: same-origin-allow-popups` so OAuth popup flows remain usable;
- HSTS only when `PUBLIC_ORIGIN` is HTTPS and the request is known to be behind the configured proxy.

For state-changing domain `/api/*` routes, test exact `Origin: https://tango.warasugi.com`, matching `X-Tango-CSRF` header and host-only CSRF cookie, absent/mismatched origin, expired token, and cross-site Fetch Metadata. Exempt safe methods and the exact mounted Better Auth handler subtree because Better Auth owns its auth-route origin/CSRF protections; integration tests must still prove its sign-in/link/callback requests reject invalid origins. Guest start remains Tango Origin/Fetch-Metadata protected and additionally requires Turnstile. Exemption is attached to the mounted handler, not a broad string suffix such as `/callback/*`.

Run:

```powershell
bun test apps/api/src/middleware/security-headers.test.ts apps/api/src/middleware/csrf.test.ts
```

Expected: failures before middleware exists.

**Step 2: Implement headers and double-submit CSRF**

Add `GET /api/security/csrf` that creates a 256-bit random token in `__Host-tango-csrf` (`Secure`, `Path=/`, `SameSite=Lax`, not HttpOnly) and returns the same token. Store no server-side secret for this token; compare cookie/header in constant time after strict base64url decoding. Actor/session cookies remain HttpOnly and are never reused as CSRF tokens.

Trust `CF-Connecting-IP` and `X-Forwarded-Proto` only when `TRUST_CLOUDFLARED=true` and the direct connection comes through the private Compose network. Since the application service has no published host port in production, no external client can inject these headers directly. Local/test defaults must not trust them.

**Step 3: Write failing body-limit and rate-limit integration tests**

Lock limits:

| Scope | Limit |
|---|---:|
| generic JSON body | 1 MiB |
| import preview upload | 10 MiB |
| guest start | 10 / IP fingerprint / 10 min |
| auth start/link | 20 / IP fingerprint / 10 min |
| import preview/apply | 20 / principal / 10 min |
| review submit | 240 / principal / min |
| export/backup | 5 / principal / hour |

Test the last allowed request, first blocked request, window expiry via injected clock, separate principal/IP keys, request body rejection before parsing, and response `429` with `Retry-After`. Hash normalized IP with an HMAC secret before persistence; tests prove the raw IP does not appear in DB.

Run:

```powershell
bun test apps/api/src/middleware/rate-limit.integration.test.ts
```

Expected: failing tests before migration/repository.

**Step 4: Implement durable fixed-window limits and retention**

Create `rate_limit_windows` with `(scope,key_hash,window_start)` primary key, counter, and expiry. Increment with one atomic upsert. Add `PAYLOAD_TOO_LARGE` to the shared error union for 413 responses. Add `purge-rate-limits` maintenance command in Task 3. Application rules supplement Cloudflare WAF and remain effective if WAF configuration drifts.

The body limiter streams/counts bytes and returns 413 without logging body content. Keep import candidate/count limits from Phase 2 in addition to byte limits.

**Step 5: Write failing audit/redaction tests**

Audit only authentication, provider link/unlink, principal merge, import apply, export/full-backup, trash purge, account deletion, security-limit events, and maintenance summaries. Assert audit JSON never includes card front/back, import raw payload, cookies, authorization headers, OAuth codes/tokens, provider access token, database URL, secret file path content, or raw IP.

**Step 6: Implement append-only audits and file-based secret inputs**

Extend the Phase 1 `audit_logs` table with HMAC IP fingerprint, bounded metadata allowlist, and outcome while preserving event type, actor/principal, request ID, and timestamp. Do not create a second audit table. Runtime repository exposes insert/query only; production grants deny direct update/delete and a SECURITY DEFINER retention function validates cutoff/batch size for the maintenance role. Account deletion leaves audit identity references nullable and never blocks domain-row cascades.

`env.ts` accepts each secret as either a direct development variable or a corresponding `_FILE` path, rejects both at once, reads a maximum 64 KiB, trims one terminal newline, and never includes the value in errors. Production Compose supplies `_FILE` inputs. Add all local `.env`, secret, certificate private-key, tunnel credential, dump, backup test-output, and compiled `out/` paths to `.gitignore`; keep `.env.example` values blank and explanatory.

**Step 7: Verify Task 1**

```powershell
bun test apps/api/src/middleware packages/db/src/repositories/rate-limit-repository.integration.test.ts
bun run db:migrate:test
bun run typecheck
bun run lint
```

Expected: security, limit, audit, migration, typing, and lint checks pass.

---

### Task 2: Create reproducible App/DB images and separate LXC Compose stacks

**Files:**

- Create: `infra/images.lock`
- Create: `infra/scripts/resolve-image-digests.ts`
- Create: `infra/scripts/verify-compose.ts`
- Create: `infra/app/Dockerfile`
- Create: `infra/app/compose.yml`
- Create: `infra/app/.env.example`
- Create: `infra/app/cloudflared/config.yml.example`
- Create: `infra/app/healthcheck.ts`
- Create: `infra/db/Dockerfile.pgbackrest`
- Create: `infra/db/compose.yml`
- Create: `infra/db/.env.example`
- Create: `infra/db/postgres/postgresql.conf`
- Create: `infra/db/postgres/pg_hba.conf.example`
- Create: `infra/db/postgres/init-roles.sh`
- Create: `infra/db/pgbackrest/pgbackrest.conf.example`
- Modify: `infra/test/compose.yml`
- Create: `infra/test/compose.test.ts`
- Create: `docs/operations/lxc-prerequisites.md`
- Create: `docs/operations/network-and-tls.md`

**Step 1: Write failing artifact-policy tests**

Static tests parse Dockerfiles/Compose/YAML and assert:

- every external base/service image reference has version and digest matching `infra/images.lock`, while Tango uses only the exact 40-hex Git SHA tag;
- App Dockerfile has a non-root runtime user, production-only artifacts, read-only root filesystem compatibility, and no source maps/secrets;
- App service publishes no host port and cloudflared shares only the private app network;
- DB maps 5432 only to `${DB_LXC_ADDRESS}`, has no default `0.0.0.0`, and uses TLS/SCRAM config;
- App and DB are separate Compose projects and share no Docker socket;
- containers use `no-new-privileges`, dropped capabilities, explicit healthchecks, log rotation, resource limits, and restart policy;
- secret values enter through read-only files, never Compose `environment` literals;
- runtime, migrator, maintenance, and backup DB roles are distinct and the runtime role cannot update/delete `review_events` or `audit_logs`;
- production volume paths are explicit LXC mount points, not anonymous volumes.

Run:

```powershell
bun test infra/test/compose.test.ts
```

Expected: missing-artifact failures.

**Step 2: Resolve and lock real image digests**

`resolve-image-digests.ts` accepts the three approved version tags through validated CLI options, invokes `docker buildx imagetools inspect` through `Bun.spawn` with an argument array, selects the target `linux/amd64` manifest digest, and rewrites only `infra/images.lock`. It fails if a tag is missing, media type is unexpected, or a digest is not `sha256:` plus 64 lowercase hex characters. Review the diff before using the values.

Cloudflared version must be a stable release verified from Cloudflare's official image registry on the execution date; `latest` is forbidden. The resolver also records the Debian snapshot timestamp and exact pgBackRest and `age` package versions in `infra/images.lock`; the Dockerfile installs those exact versions from the recorded snapshot and writes them to OCI labels/startup logs. If either package cannot meet the restore test, stop and request dependency-image approval instead of silently downloading another binary.

`age` is the only added operations package: it provides small, streaming, authenticated public-key encryption so the DB LXC needs only recipients and the recovery key can remain elsewhere. Its disadvantage is that disaster recovery needs the matching `age` binary/private key. An encrypted filesystem alone was rejected because copied dump files would lose protection, GnuPG has more keyring state, and restic adds a second repository system. Claude must call out this dependency when Phase 4 execution is approved; do not substitute another tool silently.

**Step 3: Build the App image**

Use a multi-stage build: locked Bun Debian builder runs `bun install --frozen-lockfile`, typecheck, tests only in CI stage, and production build; runtime copies built SPA/API and production dependencies, runs as numeric non-root UID/GID, exposes 3000 only as image metadata, and starts `apps/api/src/index.ts` with `NODE_ENV=production`, `TZ=Asia/Tokyo`. Runtime healthcheck calls an internal Bun script rather than curl.

The SPA is served by Hono from immutable hashed assets with one-year cache; `index.html` and API responses use no-store. Do not put nginx in front because cloudflared connects directly to Hono and an extra reverse proxy adds no required boundary.

**Step 4: Build App Compose and Tunnel contract**

`infra/app/compose.yml` contains `tango` and `cloudflared`. Tango has no `ports`; cloudflared routes `https://tango.warasugi.com` to `http://tango:3000` and a final `http_status:404` ingress rule. Named-tunnel credential JSON and config are root-owned bind mounts; the example contains no tunnel ID or credential. Set `PUBLIC_ORIGIN`, trusted proxy mode, `_FILE` secret paths, DB TLS CA/name, resource limits, and read-only/tmpfs mounts.

Cloudflare dashboard-side instructions require DNS to the named tunnel, TLS Full/strict on public edge, available-plan WAF rules for auth/guest/import, Turnstile keys, and no Cloudflare Access because invited family/friends authenticate in Tango. Verify the account's current free-plan rule quota before proposing rules; application limits remain mandatory if a rule type is unavailable, and no paid upgrade is authorized. Document rollback as disabling the hostname route and restoring prior config; do not apply it in this Phase.

**Step 5: Build DB Compose and TLS/SCRAM boundary**

PostgreSQL binds `${DB_LXC_ADDRESS}:5432`, uses a certificate whose SAN is `tango-db.internal`, sets `ssl=on`, `password_encryption=scram-sha-256`, explicit timezone `Asia/Tokyo` for display, and keeps data as `timestamptz`. Disable statement/parameter-value logging, retain duration/connection/error signals needed for operations, and have Zabbix report long-query counts without query text. `pg_hba.conf` permits SSL from only `APP_LXC_ADDRESS/32` using `scram-sha-256`, local health, and replication/pgBackRest roles as required; reject comes last. Runtime App `DATABASE_URL_FILE` uses `sslmode=verify-full` and the internal name; deployment migration uses a separately mounted `MIGRATOR_DATABASE_URL_FILE`.

`init-roles.sh` reads four distinct root-only password files and creates `tango_runtime`, `tango_migrator`, `tango_maintenance`, and `tango_backup` without printing values. Migrator owns migrations; runtime receives only normal application DML plus INSERT/SELECT on immutable events/audits; maintenance can execute allowlisted retention functions; backup receives only pgBackRest-required privileges. PostgreSQL data lives at `/srv/tango/postgres`, backup staging at `/srv/tango/dumps`, and pgBackRest repository at `BACKUP_ROOT` mounted from a different failure domain.

`network-and-tls.md` uses a dedicated offline Tango private CA created with OpenSSL—no new CA service. The CA private key stays outside both LXCs; DB receives only its server key/cert/full chain, App receives only the CA certificate. `tango-db.internal` resolves through an approved AdGuard Home internal record, with an explicit `/etc/hosts` entry as the rollback-safe alternative. Document issuance, SAN/hostname verification, root-only modes, PostgreSQL reload, overlap rotation with old files retained, client verification, expiry alert, and rollback. Do not change AdGuard Home or install certificates during this Phase.

**Step 6: Document Debian 12/13 unprivileged LXC preflight**

`lxc-prerequisites.md` lists CPU/RAM/disk assumptions, fixed internal addressing, time sync, Docker repository verification, AppArmor/cgroup checks, `nesting`/`keyctl` requirement, UID/GID ownership for bind mounts, firewall matrix, and Proxmox snapshot/backup before change. Debian 13 is primary; Debian 12 follows the same artifacts.

For every host-side change, document purpose, benefit, risk, read-only preflight, command to apply after approval, verification, and exact rollback. Never recommend privileged mode as a routine fix. If unprivileged Docker fails, collect cgroup/AppArmor/storage-driver evidence and stop rather than broadening privileges.

**Step 7: Verify artifacts in isolated Compose**

```powershell
bun infra/scripts/verify-compose.ts
docker compose -f infra/test/compose.yml build --pull=false
docker compose -f infra/test/compose.yml up -d --wait
bun test infra/test/compose.test.ts
docker compose -f infra/test/compose.yml exec -T tango bun run db:status
docker compose -f infra/test/compose.yml down
```

Expected: validated config, healthy app/DB, successful TLS DB connection, no host App port, and clean shutdown. Test script must use a task-scoped Compose project name and explicit workspace paths; it must not remove unrelated volumes.

---

### Task 3: Make retention and maintenance one-shot, observable, and retry-safe

**Files:**

- Create: `apps/api/src/jobs/job-runner.ts`
- Modify: `apps/api/src/jobs/purge-expired-guests.ts`
- Create: `apps/api/src/jobs/purge-expired-guests.integration.test.ts`
- Modify: `apps/api/src/jobs/purge-trash.ts`
- Create: `apps/api/src/jobs/purge-trash.integration.test.ts`
- Modify: `apps/api/src/jobs/purge-import-previews.ts`
- Create: `apps/api/src/jobs/purge-rate-limits.ts`
- Create: `apps/api/src/jobs/purge-audit.ts`
- Create: `apps/api/src/features/auth/account-deletion-service.ts`
- Create: `apps/api/src/features/auth/account-deletion-service.integration.test.ts`
- Create: `apps/api/src/features/auth/account-deletion-routes.ts`
- Create: `apps/api/src/features/auth/account-deletion-routes.test.ts`
- Modify: `apps/api/src/features/auth/better-auth.ts`
- Modify: `apps/api/src/features/auth/auth-routes.ts`
- Create: `packages/shared/src/contracts/api/account-deletion.ts`
- Create: `apps/web/src/features/auth/account-deletion-panel.tsx`
- Create: `apps/web/src/features/auth/account-deletion-panel.test.tsx`
- Modify: `apps/web/src/features/auth/account-panel.tsx`
- Create: `apps/api/src/jobs/jobs.integration.test.ts`
- Create: `infra/app/systemd/tango-maintenance@.service`
- Create: `infra/app/systemd/tango-purge-expired-guests.timer`
- Create: `infra/app/systemd/tango-purge-trash.timer`
- Create: `infra/app/systemd/tango-purge-ephemeral.timer`
- Create: `docs/operations/maintenance.md`

**Step 1: Write failing retention/integrity tests**

With injected `Temporal.Instant`, test:

- inactive guest older than 90 elapsed days is deleted, active/linked guest remains;
- warning threshold at 30 days is query-only and purge does not depend on learning day;
- guest merge in progress is locked/skipped, never partially deleted;
- deck/card trash is purged only after 30 elapsed days and cascades schedules/events;
- restoring trash before cutoff preserves schedule/history;
- expired unconfirmed import batch/candidates are removed without touching applied content;
- rate-limit windows purge 48 hours after expiry and audit rows purge after configurable `AUDIT_RETENTION_DAYS` (default 180, allowed 30–365);
- each command can be rerun after success with zero additional domain changes;
- two simultaneous runners serialize through a PostgreSQL advisory lock and one exits successfully as skipped;
- dry-run produces counts and IDs only, never card content;
- account deletion authorization rejects a session older than 10 minutes or confirmation text other than `アカウントと全データを削除`;
- a valid authorization sets a five-minute Host-only HttpOnly Secure SameSite=Strict confirmation cookie tied to the Better Auth user ID;
- Better Auth direct deletion without that cookie is rejected by `beforeDelete`, while valid deletion cascades the user, principal, content, schedules/events, and sessions in one database delete and leaves only redacted audit rows with null identity references.

Run:

```powershell
bun test apps/api/src/jobs apps/api/src/features/auth/account-deletion-service.integration.test.ts apps/api/src/features/auth/account-deletion-routes.test.ts apps/web/src/features/auth/account-deletion-panel.test.tsx
```

Expected: failures before commands and deletion flow exist.

**Step 2: Implement one-shot commands**

Expose `bun run job -- <name> [--dry-run]` with a closed enum of job names; no shell interpolation. Each job obtains its own advisory lock, processes bounded batches of 500, commits per batch, records a maintenance audit summary, and exits nonzero on any unhandled failure. Validate `AUDIT_RETENTION_DAYS` as 30–365 with default 180; rate-limit rows become purgeable 48 hours after their window expires. Do not run timers inside the API process.

Account deletion is not a maintenance job. `POST /api/account/deletion/authorize` requires the exact Japanese confirmation and a Better Auth session inside the configured 10-minute `freshAge`; otherwise the UI instructs sign-out/sign-in through Google or GitHub. It sets a five-minute signed `__Host-tango-delete` confirmation cookie bound to user ID. Enable Better Auth `user.deleteUser`, and require that cookie in `beforeDelete`; the UI then calls the official `deleteUser` method. The account panel shows irreversible scope, export action, confirmation input, and fresh-login recovery before calling either endpoint. Deleting the Better Auth user triggers the Phase 1 principal FK cascade atomically; audit FKs become null. Backup retention remains independent and is documented to age out encrypted copies.

**Step 3: Create hardened systemd units**

The templated service invokes the already-running image with `docker compose run --rm --no-deps tango bun run job -- %i`, has overlap protection via the DB lock, timeout, bounded retries, and journal output. Timers use `Asia/Tokyo`: guests daily 01:30, trash daily 01:45, imports/rate limits/audit daily 02:15, with randomized delay up to 10 minutes and `Persistent=true`.

Document installation, `systemd-analyze verify`, dry-run, enable, status, manual invocation, journal inspection, disable, and file removal rollback. Do not install/enable units during this Phase.

**Step 4: Verify Task 3**

```powershell
bun test apps/api/src/jobs apps/api/src/features/auth/account-deletion-service.integration.test.ts apps/api/src/features/auth/account-deletion-routes.test.ts apps/web/src/features/auth/account-deletion-panel.test.tsx
bun run typecheck
docker compose -f infra/test/compose.yml run --rm tango bun run job -- purge-expired-guests --dry-run
```

Expected: retention, concurrency, dry-run, and type checks pass.

---

### Task 4: Implement pgBackRest, logical dumps, and isolated restore drills

**Files:**

- Create: `infra/db/scripts/pgbackrest-entrypoint.sh`
- Create: `infra/db/scripts/logical-backup.sh`
- Create: `infra/db/scripts/check-backup.sh`
- Create: `infra/recovery/restore-drill.sh`
- Create: `infra/db/systemd/tango-pgbackrest-full.service`
- Create: `infra/db/systemd/tango-pgbackrest-full.timer`
- Create: `infra/db/systemd/tango-pgbackrest-diff.service`
- Create: `infra/db/systemd/tango-pgbackrest-diff.timer`
- Create: `infra/db/systemd/tango-pgdump.service`
- Create: `infra/db/systemd/tango-pgdump.timer`
- Create: `infra/test/backup-restore.integration.test.ts`
- Create: `docs/operations/backup-and-restore.md`
- Create: `docs/operations/disaster-recovery.md`

**Step 1: Write the failing isolated backup/restore acceptance script**

The script must create a task-scoped test stack, seed formal/guest principals, content, FSRS schedules, review/undo history, and audit events, capture canonical checksums/counts, take backup, add a post-backup marker, restore into a separate destination cluster, and compare semantic checksums. PITR target immediately before the marker must exclude it; a later target must include it.

It also corrupts/removes one test backup file and proves `check` fails without altering the source cluster. Cleanup resolves and prints exact test project/volume names and refuses any name without the `tango_restore_test_` prefix.

Run:

```powershell
bun test infra/test/backup-restore.integration.test.ts
```

Expected: failure until backup services and scripts exist.

**Step 2: Configure continuous WAL and backup retention**

pgBackRest uses a POSIX repository on `BACKUP_ROOT`, AES-256 repository encryption with passphrase supplied from a root-only secret file, synchronous archive push, `process-max` sized conservatively, `repo1-retention-full=4`, and differential retention sufficient for 14 daily recovery points. PostgreSQL uses `archive_mode=on`, `archive_timeout=60s`, and an `archive_command` that returns nonzero until the separate-failure-domain repository confirms the WAL. Monitor archive age; never delete WAL manually.

Schedule full backup Sunday 03:30 JST, differential Monday–Saturday 03:30 JST, and `pgbackrest check` after every run. Continuous archive targets RPO 15 minutes; alert if the newest archived WAL exceeds 15 minutes.

**Step 3: Add daily logical backup**

At 02:00 JST stream custom-format `pg_dump` and separate globals/roles metadata directly through `age` to temporary encrypted files in `/srv/tango/dumps`; no plaintext dump is written. Recipients come from a checked public recipients file, while the private recovery identity remains outside the DB LXC and is mounted only into the isolated restore drill. Decrypt to a pipe for `pg_restore --list`, atomically rename the encrypted set/manifest/checksums, and retain 7 daily, 4 weekly, and 6 monthly sets using JST calendar labels. Do not place passwords, recovery identities, or decrypted data on command lines/logs. A logical dump complements pgBackRest and is not counted as continuous-WAL recovery.

**Step 4: Add a quarterly operator-triggered destructive-safe restore drill**

From an approved recovery host outside the DB LXC, an operator runs the drill once per quarter with temporary read-only access to the backup repository, pgBackRest cipher secret, and private `age` identity. Restore the latest physical and logical backups into new task-named Docker volumes/isolated ports, run migration read-only status, invariants, row/checksum comparisons, record duration/result, then stop the drill clusters. Never automate a restore over production. The script refuses a destination matching production data path, Compose project, container, hostname, or port and never copies the recovery identity into an image/volume.

`disaster-recovery.md` covers full-cluster loss, latest restore, point-in-time restore, logical restore, application secret/certificate restoration, DNS/Tunnel recovery, verification, declaring recovery complete, and rollback/abort. Target evidence must show RPO ≤15 min and measured restore under 2 hours on representative data.

**Step 5: Verify Task 4**

```powershell
bun test infra/test/backup-restore.integration.test.ts
docker compose -f infra/test/compose.yml run --rm pgbackrest pgbackrest --stanza=tango check
```

Expected: full, differential/PITR semantics, logical dump validation, corruption detection, and safe cleanup pass.

---

### Task 5: Add health contracts and Uptime Kuma/Zabbix/Discord monitoring guidance

**Files:**

- Create: `apps/api/src/features/operations/health-routes.ts`
- Create: `apps/api/src/features/operations/health-routes.test.ts`
- Create: `apps/api/src/features/operations/health-service.ts`
- Create: `apps/api/src/features/operations/health-service.integration.test.ts`
- Modify: `apps/api/src/app.ts`
- Create: `infra/monitoring/zabbix/tango-userparameter.conf`
- Create: `infra/monitoring/zabbix/tango-check.sh`
- Create: `infra/monitoring/zabbix/tango-check.test.ts`
- Create: `infra/monitoring/uptime-kuma.md`
- Create: `infra/monitoring/discord.md`
- Create: `docs/operations/monitoring.md`
- Create: `docs/operations/runbooks.md`

**Step 1: Write failing health tests**

Add contracts:

- `GET /health/live`: process can serve, no DB call, 200 `{ status:'ok', version }`;
- `GET /health/ready`: bounded 1-second DB `SELECT 1` and migration-version check, 200 ready or 503 unavailable;
- neither endpoint exposes hostname, DB URL, schema details, exception text, user counts, or secret names;
- readiness becomes 503 on DB timeout, failed migration, or draining state while liveness remains 200;
- response is `no-store` and rate-limit exempt but audit-free.

Run:

```powershell
bun test apps/api/src/features/operations
```

Expected: failure before health routes exist.

**Step 2: Implement bounded health and graceful shutdown**

Use injected database health interface and timeout signal. On SIGTERM, set draining state, fail readiness, stop accepting new connections, allow in-flight review/import transactions up to 20 seconds, then close DB pool. Health version comes from build metadata without invoking Git in runtime.

**Step 3: Define monitoring checks without secrets**

Uptime Kuma guide creates separate HTTPS monitors for public `/health/live` and `/health/ready` at 60 seconds, Google/GitHub OAuth start at 60 minutes expecting each configured provider redirect without following it, and certificate expiry. The OAuth monitor request is copied from the request shape emitted and integration-tested by the installed Better Auth client; do not guess endpoint/payload fields in documentation. Require 3 failures before alert, immediate recovery notices, and Discord notification with no embedded webhook in screenshots/files.

Zabbix UserParameters report App/DB/cloudflared container health, disk free/inodes, PostgreSQL connection/capacity/connection use/long-query count, archive age, pgBackRest last successful full/diff, logical dump age, maintenance job failure, certificate expiry, CPU/memory, and restart count. Scripts output numeric/string values only and use least-privilege read-only commands. They never use Docker socket from an application container; Zabbix agent on each LXC executes host checks under an allowlisted command.

Discord guide prefers one existing Bot/Webhook integration per monitoring system, sends outage/DB-unready/backup-delay immediately, routes capacity/certificate warnings at warning severity, sends recovery notices, avoids card/user content, and provides a redacted test message. Document secret rotation and disabling notification rollback.

**Step 4: Write actionable runbooks**

For readiness down, DB unavailable, disk pressure, WAL archive lag, backup failure, restore drill failure, excessive rate limiting, Tunnel down, OAuth provider failure, and guest purge failure, document signal, impact, safe diagnosis, escalation threshold, remediation, verification, and rollback. Commands default to read-only inspection.

**Step 5: Verify Task 5**

```powershell
bun test apps/api/src/features/operations
bun run typecheck
bun test infra/monitoring/zabbix/tango-check.test.ts
```

Expected: health behavior and monitoring script self-tests pass.

---

### Task 6: Document staged deployment, migration safety, and rollback rehearsal

**Files:**

- Create: `infra/scripts/preflight.ts`
- Create: `infra/scripts/deploy-app.ts`
- Create: `infra/scripts/rollback-app.ts`
- Create: `infra/scripts/tango-ops.ts`
- Create: `infra/scripts/command-runner.ts`
- Create: `infra/scripts/scan-secrets.ts`
- Create: `infra/test/deploy-rollback.test.ts`
- Create: `infra/test/scan-secrets.test.ts`
- Create: `docs/operations/deployment.md`
- Create: `docs/operations/rollback.md`
- Create: `docs/operations/cloudflare.md`
- Create: `docs/operations/secrets.md`
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`

**Step 1: Write failing script safety tests**

Tests must prove scripts:

- require explicit `--environment=production --commit=<40-hex>` and refuse branch/tag names or an unpushed/unreachable commit;
- show current/new Git SHA, local image ID, migration list, backup freshness, health, disk, and exact Compose project before change;
- default to dry-run and need `--apply` for mutation;
- refuse dirty/missing operation config, stale backup, failed pgBackRest check, insufficient disk, or unreachable DB;
- refuse production readiness when `PRIVACY_CONTACT_URL` is absent/invalid or public `/privacy` is unavailable;
- never run `docker system prune`, remove volumes, edit Proxmox, or call Cloudflare APIs;
- rollback selects an explicitly recorded prior digest and never reverses a destructive DB migration automatically;
- quote literal paths and reject targets outside `/opt/tango` and `/etc/tango` on the remote LXC helper contract.

Run:

```powershell
bun test infra/test/deploy-rollback.test.ts infra/test/scan-secrets.test.ts
```

Expected: failure before scripts/docs exist.

**Step 2: Implement preflight and staged deployment helper**

Preflight is read-only. Deployment after separate approval fetches without changing the working tree, verifies the exact approved SHA exists on the configured `warasugitewara/tango-web` remote, creates a clean release worktree under `/opt/tango/releases/<SHA>`, builds `tango-web:<SHA>` with `--pull=false` from digest-locked bases, records its image ID/config labels, confirms a recent successful backup, runs migration status, applies only reviewed forward migrations, starts the new app, waits for readiness, performs guest/login/import/study smoke checks with a dedicated non-production-content canary principal, and leaves the prior worktree/image available. It does not publish an image or require a container registry.

The three operations modules share an injected allowlisted `CommandRunner`; `tango-ops.ts` is the only CLI entrypoint. CI compiles it with Bun into a checksum-recorded `linux-x64` standalone binary for `/opt/tango/bin/tango-ops`, so the LXC host needs no Bun installation. The binary runs locally on the App LXC; Windows-side instructions reach it over the operator's approved SSH/Twingate path and use Nushell syntax. Scripts generate an operation transcript with timestamps and redacted commands. They never log environment/secret contents. A migration must be backward compatible with the prior app image; otherwise deployment docs require maintenance window and PITR rollback decision before application.

**Step 3: Implement explicit rollback paths**

Application rollback restores the prior digest/config, waits for readiness, and runs smoke checks. Database rollback defaults to forward-fix; if data/schema rollback is unavoidable, stop writes, preserve current failed state, restore an isolated PITR candidate, verify it, and only then request approval to replace production. Cloudflare rollback restores the previous ingress config/DNS route. Every path names impact and expected downtime.

**Step 4: Add a bounded repository secret scan and extend CI without auto-deployment**

`scan-secrets.ts` inspects tracked/staged files for private-key headers, provider/database secret assignments with non-example values, tunnel credential fields, known token prefixes, and files forbidden by `.gitignore`; its allowlist contains only explicit fixture line hashes. Tests seed one detection case for every pattern and one safe `.env.example`. This dependency-free scan is a guardrail, not a replacement for credential rotation or GitHub secret scanning.

CI runs format, lint, typecheck, unit/integration, build, migration clean-upgrade test, Compose static policy, browser E2E, `scan-secrets.ts`, and Docker build. It may publish no image, deploy no environment, change no DNS/Tunnel, and use no production secrets in this Phase. Upload failure traces/reports with bounded retention.

**Step 5: Verify Task 6**

```powershell
bun infra/scripts/tango-ops.ts preflight --environment=test
bun infra/scripts/scan-secrets.ts
bun test infra/test/deploy-rollback.test.ts infra/test/scan-secrets.test.ts
bun build infra/scripts/tango-ops.ts --compile --target=bun-linux-x64 --outfile out/tango-ops
bun run ci
```

Expected: preflight report, safe deploy/rollback rehearsal, and the complete CI-equivalent suite pass.

---

### Task 7: Run final acceptance and produce the production-readiness review packet

**Files:**

- Create: `e2e/security-boundaries.spec.ts`
- Create: `e2e/production-smoke.spec.ts`
- Create: `docs/reviews/phase-4-review-template.md`
- Create: `docs/operations/acceptance-checklist.md`

**Step 1: Run application/security acceptance tests**

Test CSRF, origin enforcement, cookie flags, CSP, unauthorized ownership boundaries, rate limits, 10 MiB import rejection, OAuth callback compatibility, Markdown XSS payloads, idempotent review retry, account/guest merge, and redacted audit data. Run production-mode smoke against the isolated Compose stack at desktop/mobile sizes.

```powershell
bun run e2e -- e2e/security-boundaries.spec.ts e2e/production-smoke.spec.ts
```

Expected: all security and smoke scenarios pass.

**Step 2: Verify Debian and operations evidence**

Use disposable Debian 13 and Debian 12 LXC/VM test targets supplied by the user or CI lab. On each: install only documented prerequisites, validate Compose, start stacks, migrate, pass live/ready, execute logical backup and pgBackRest check, run one dry-run maintenance job, and stop cleanly. If no approved disposable target exists, mark this acceptance item unverified and do not claim production readiness; local Docker success is not a substitute for LXC evidence.

Run the isolated PITR test, restore-duration measurement, application rollback rehearsal, Zabbix self-test, and Uptime Kuma/Discord redacted test after the relevant external systems are separately approved. No live mutation is implied by this plan.

**Step 3: Run final repository verification**

```powershell
bun run format:check
bun run lint
bun run typecheck
bun test
bun run test:integration
bun run build
bun run e2e
bun infra/scripts/verify-compose.ts
bun test infra/test/backup-restore.integration.test.ts
bun test infra/test/deploy-rollback.test.ts infra/test/scan-secrets.test.ts
git diff --check
git status --short
```

Record exact commands, exit codes, totals, image digests, migration hashes, restore duration/recovery point, and artifact paths.

**Step 4: Prepare the final review packet, create the Task commit, and stop**

Fill `docs/reviews/phase-4-review-template.md` with:

- exact Task 1–6 commit range/map;
- all prior review-gate findings and resolutions;
- `0003_operations_security.sql` and clean/upgrade migration evidence;
- image versions/digests, locked Debian snapshot/package version, and build output paths;
- security-boundary and secret-scan results;
- Debian 12/13 evidence status;
- pgBackRest/PITR/logical restore checks and measured RPO/RTO;
- App/DB/Cloudflare network exposure table;
- maintenance schedule and dry-run evidence;
- health/monitoring/Discord configuration checklist;
- deploy/rollback rehearsal transcript;
- remaining external actions requiring separate approval.

After the required Task checks including the secret scan, stage only Task 7 paths and commit `test(ops): 本番運用の受入検証とレビュー資料を追加`. Do not push, deploy, create LXC, enable timers, or change external systems. Stop for Codex final review.

## Phase 4 Exit Criteria

- Production image/Compose artifacts are digest-locked, non-root, least-privilege, and separate App/DB LXC boundaries are testable.
- No public App port exists; Cloudflare Tunnel is the only public path; DB accepts only App LXC over verified TLS/SCRAM.
- CSRF, XSS/CSP, body/rate limits, audit redaction, and secret-file loading have automated evidence.
- Guest/trash/import/rate/audit maintenance is one-shot, idempotent, observable, and externally scheduled.
- Continuous WAL, weekly full, daily differential, daily logical backup, corruption check, isolated restore/PITR drill, and safe cleanup are proven.
- Health endpoints, monitoring checks, Discord guidance, and incident runbooks expose no private content.
- Deployment defaults to read-only preflight; mutation and external-system steps require separate approval and have explicit rollback.
- Debian 12/13 evidence is clearly passed or clearly unverified; production readiness is never claimed from local-only evidence.
- Complete Task commit range and review packet are ready for Codex; no push/deploy/external change occurs without separate approval.
