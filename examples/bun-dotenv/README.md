# shortly (bun-dotenv)

A link shortener made with different choices from storefront: Bun instead of Node, plain `.env` files instead of varlock, Redis instead of Temporal.

- `apps/api` Bun.serve plus Bun's built-in Postgres (`Bun.SQL`) and Redis clients. Shortening a link queues a check in Redis.
- `apps/worker` pops the queue and marks the link as checked.
- `apps/web` server-rendered page that calls the api by URL.
- `.env` committed defaults, `.env.local` personal overrides (`LINK_TTL_DAYS=7` wins). `ANALYTICS_URL` is left unmapped on purpose.

`forkyard.config.ts` uses the same shared Postgres as storefront but without a template (each branch gets an empty database and the `migrate` task creates the table), and starts a separate `redis-server` per branch.
