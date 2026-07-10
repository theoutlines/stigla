# Environments: production & staging

Two independent web environments share one codebase and one repo.

| | Production | Staging |
|---|---|---|
| Web | `stigla.theoutlines.xyz` | `staging.stigla.pages.dev` (link only) |
| API (worker) | `stigla-api.theoutlines.xyz` | `stigla-api-staging.theoutlines.xyz` |
| Worker | `stigla-backend` | `stigla-backend-staging` (`[env.staging]`) |
| KV / D1 | prod namespaces | **separate** staging KV + `stigla-{ideas,analytics}-staging` D1 |
| `ENVIRONMENT` | `production` | `staging` |
| In-dev feature flags | default **OFF** | default **ON** |
| Cron | daily | none |
| Marker | — | amber **STAGING** badge on every screen |

## Data isolation

Staging is a fully separate worker (`wrangler [env.staging]`) bound to its **own**
KV and D1 databases, so it can never write to production feedback / ideas /
analytics. It has its own SWR cache but the same 1-request-per-30s cap to the
upstream source, and it's only used by one person — so no extra source load in
practice. The kill switch works per-environment (separate KV).

## Feature flags per environment

Flags live in each environment's own KV (same mechanism as the kill switch). When
a flag's KV key is **unset**, the default depends on `ENVIRONMENT`
(`backend/src/lib/featureFlags.ts`): **ON** on staging (so in-development features
are exercisable), **OFF** on production. An explicit KV value always overrides the
default, in either environment. `/api/v1/config` reports `environment` + `flags`.

## Promoting a feature

There's no permanent `develop` branch — staging is deployed on demand from
whatever branch you're testing.

```sh
# 1) Send the current branch to staging (test it there, flags on):
cd backend && npm run deploy:staging          # worker → stigla-api-staging
cd ../app && flutter build web --release \
  --dart-define-from-file=dart_defines.json \
  --dart-define=API_BASE_URL=https://stigla-api-staging.theoutlines.xyz \
  --dart-define=ENVIRONMENT=staging
npx wrangler pages deploy build/web --project-name=stigla --branch=staging
# → https://staging.stigla.pages.dev  (shows the STAGING badge, dev flags ON)

# 2) When it's ready, promote to production:
git checkout main && git merge <feature-branch> && git push
cd backend && npm run deploy                   # prod worker
cd ../app && flutter build web --release --dart-define-from-file=dart_defines.json
npx wrangler pages deploy build/web --project-name=stigla --branch=main
# dev flags stay OFF on prod until you flip them (admin/flags), no rebuild needed
```

> Note: the MapTiler key is origin-restricted. If the map is blank on
> `staging.stigla.pages.dev`, add that origin to the key's allowed origins in the
> MapTiler dashboard (analytics/list screens don't need it).
