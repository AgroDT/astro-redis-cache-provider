import type { CacheProviderConfig } from "astro";

import type { RedisCacheProviderOptions } from "./runtime.js";

/**
 * Creates Astro cache provider configuration for the Redis runtime provider.
 */
export function redisCache(
  config: RedisCacheProviderOptions = {},
): CacheProviderConfig<RedisCacheProviderOptions> {
  return {
    name: "redis",
    entrypoint: "@agrodt/astro-redis-cache-provider/runtime",
    config,
  };
}

export default redisCache;
