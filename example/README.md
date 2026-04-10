# @agrodt/astro-redis-cache-provider example

Minimal Astro app that demonstrates this Redis cache provider behavior:

- home page (`/`) with explanation + controls
- cached page (`/cache-demo`) with cache status
- manual cache invalidation endpoint (`POST /api/invalidate-cache`)

## Run

Start Valkey (from repository root):

```bash
docker compose up -d valkey
```

Install and run the example:

```bash
cd example
pnpm install
pnpm astro build
pnpm astro preview
```

> [!NOTE]
> Astro dev mode does not perform real route caching.
> Use `build + preview` for verification.

Open:

- `http://127.0.0.1:4321/` (home)
- click `Open cached page` to open `/cache-demo` in a new tab

## Expected flow

1. Open `/` and then open the cached page in a new tab.
2. On `/cache-demo`, check `Navigation Cache Status`
3. Reload `/cache-demo` to observe stable server render IDs and `HIT`-style
   cache behavior.
4. Go back to `/` and click `Invalidate demo cache`.
5. Reload `/cache-demo` and observe a new server render ID (`MISS`) followed
   by `HIT` on subsequent loads.
