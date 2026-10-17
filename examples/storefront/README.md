# storefront

A small shop with the shape of a real product monorepo: a pnpm workspace, an API, two server-rendered web apps, background workers, SQL migrations, varlock for env, Postgres and Temporal.

- `apps/api` the API (Node http + pg). `/api/info` reports which database, Temporal server and namespaces it is connected to.
- `apps/shop`, `apps/backoffice` web apps that call the API by its URL, never by port.
- `apps/workers` picks up jobs queued from the backoffice and reports which Temporal server and namespace it runs under.
- `packages/db` SQL migrations and a migrate script. The golden template is built by running it once against an empty database.
- `.env.schema` the varlock schema. Service URLs, `DATABASE_URL` and Temporal settings have localhost defaults that forkyard replaces per branch. Auth and payment values come from `scripts/fake-secrets.mjs`, a stand-in for a secret manager; they are the same on every branch. `ANALYTICS_HOST` is left unmapped on purpose so the dashboard flags it.

`forkyard.config.ts` is the whole integration: shared Postgres with a golden template, a Temporal server per branch with three namespaces, the URL variables forkyard owns, varlock as the env source, and OpenTelemetry auto-instrumentation switched on through `NODE_OPTIONS`.

Run `forkyard up` here. In the tour, branch `feat-gift-cards` adds `003_gift_cards.sql`, so its database and shop page have a Gift cards section the others lack.
