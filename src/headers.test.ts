import assert from "node:assert/strict";
import { it } from "node:test";
import type { CacheProviderFactory } from "astro";
import { redisCache } from "./config.js";
import { createRedisCacheProvider } from "./runtime.js";

it("implements the Astro 7 provider factory and config contract", () => {
  const factory: CacheProviderFactory = createRedisCacheProvider;
  assert.equal(factory(undefined).name, "redis");
  const options = { keyPrefix: "custom" };
  assert.deepEqual(redisCache(options), {
    name: "redis",
    entrypoint: "@agrodt/astro-redis-cache-provider/runtime",
    config: options,
  });
});

it("translates Astro cache options into cache and conditional headers", () => {
  const provider = createRedisCacheProvider();
  const lastModified = new Date("2026-09-14T12:00:00Z");
  const headers = provider.setHeaders(
    {
      maxAge: 60,
      swr: 30,
      tags: ["news", "articles"],
      etag: '"v1"',
      lastModified,
    },
    new Request("https://example.com/news"),
  );
  assert.equal(
    headers.get("CDN-Cache-Control"),
    "max-age=60, stale-while-revalidate=30",
  );
  assert.equal(headers.get("Cache-Tag"), "news, articles");
  assert.equal(headers.get("ETag"), '"v1"');
  assert.equal(headers.get("Last-Modified"), lastModified.toUTCString());
});

it("omits unspecified headers and preserves zero cache durations", () => {
  const provider = createRedisCacheProvider();
  const request = new Request("https://example.com/");
  assert.deepEqual([...provider.setHeaders({}, request)], []);
  const headers = provider.setHeaders({ maxAge: 0, swr: 0, tags: [] }, request);
  assert.equal(
    headers.get("CDN-Cache-Control"),
    "max-age=0, stale-while-revalidate=0",
  );
  assert.equal(headers.has("Cache-Tag"), false);
});
