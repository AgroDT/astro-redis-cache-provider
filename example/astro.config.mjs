// @ts-check
import { defineConfig } from "astro/config";

import node from "@astrojs/node";
import { redisCache } from "@agrodt/astro-redis-cache-provider/config";

// https://astro.build/config
export default defineConfig({
  output: "server",
  adapter: node({
    mode: "standalone",
  }),
  experimental: {
    cache: {
      provider: redisCache({
        url: () => process.env.REDIS_URL,
      }),
    },
  },
});
