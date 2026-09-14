// @ts-check

import { redisCache } from "@agrodt/astro-redis-cache-provider/config";
import node from "@astrojs/node";
import { defineConfig } from "astro/config";

// https://astro.build/config
export default defineConfig({
  output: "server",
  adapter: node({
    mode: "standalone",
  }),
  cache: {
    provider: redisCache({
      url: () => process.env.REDIS_URL,
    }),
  },
});
