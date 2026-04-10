import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import process from "node:process";
import { after, before, it } from "node:test";
import { createClient, RESP_TYPES } from "redis";
import {
  createRedisCacheProvider,
  type RedisCacheProvider,
} from "./runtime.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const SCHEMA_VERSION = 1;
let provider: RedisCacheProvider & {
  onRequest: NonNullable<RedisCacheProvider["onRequest"]>;
};

function createContext(
  url: string,
  init?: RequestInit,
): { request: Request; url: URL } {
  const request = new Request(url, init);
  return { request, url: new URL(url) };
}

function uniquePrefix(name: string): string {
  return `test:astro:cache:${name}:${randomUUID()}`;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeKeyPrefix(value: string): string {
  return value.endsWith(":") ? value : `${value}:`;
}

function buildPathIndexKey(prefix: string, path: string): string {
  return `${normalizeKeyPrefix(prefix)}v${SCHEMA_VERSION}:idx:path:${hash(path)}`;
}

function buildTagIndexKey(prefix: string, tag: string): string {
  return `${normalizeKeyPrefix(prefix)}v${SCHEMA_VERSION}:idx:tag:${hash(tag)}`;
}

function cacheKeyFor(urlString: string): string {
  const url = new URL(urlString);
  const params = new URLSearchParams(url.searchParams);
  params.sort();
  const query = params.toString();
  return `${url.origin}${url.pathname}${query ? `?${query}` : ""}`;
}

async function createIsolatedProvider(name: string): Promise<{
  provider: RedisCacheProvider & {
    onRequest: NonNullable<RedisCacheProvider["onRequest"]>;
  };
  close: () => Promise<void>;
  keyPrefix: string;
}> {
  const keyPrefix = uniquePrefix(name);
  const isolated = createRedisCacheProvider({
    url: REDIS_URL,
    keyPrefix,
  });
  if (!isolated.onRequest) {
    throw new Error("Expected provider.onRequest to be defined");
  }
  return {
    provider: isolated as RedisCacheProvider & {
      onRequest: NonNullable<RedisCacheProvider["onRequest"]>;
    },
    close: () => isolated.close(),
    keyPrefix,
  };
}

before(async () => {
  const newProvider = createRedisCacheProvider({
    url: REDIS_URL,
    keyPrefix: uniquePrefix("suite"),
  });
  if (!newProvider.onRequest) {
    throw new Error("Expected provider.onRequest to be defined");
  }

  await newProvider.onRequest(
    createContext("https://example.com/__healthcheck"),
    async () => {
      return new Response("ok", {
        headers: {
          "CDN-Cache-Control": "max-age=1",
          "Cache-Tag": "healthcheck",
        },
      });
    },
  );
  await newProvider.invalidate({ path: "/__healthcheck" });

  provider = newProvider as typeof provider;
});

after(async () => {
  await provider.close();
});

it("stores response on MISS and serves HIT for same normalized URL", async () => {
  const { onRequest } = provider;

  let firstNextCalls = 0;
  const firstResponse = await onRequest(
    createContext("https://example.com/articles?page=1&utm_source=test"),
    async () => {
      firstNextCalls += 1;
      return new Response("payload-v1", {
        headers: {
          "CDN-Cache-Control": "max-age=60, stale-while-revalidate=30",
          "Cache-Tag": "articles",
        },
      });
    },
  );

  assert.equal(firstResponse.headers.get("X-Astro-Cache"), "MISS");
  assert.equal(await firstResponse.text(), "payload-v1");
  assert.equal(firstNextCalls, 1);

  let secondNextCalls = 0;
  const secondResponse = await onRequest(
    createContext("https://example.com/articles?page=1&utm_source=test"),
    async () => {
      secondNextCalls += 1;
      return new Response("payload-v2");
    },
  );

  assert.equal(secondResponse.headers.get("X-Astro-Cache"), "HIT");
  assert.equal(await secondResponse.text(), "payload-v1");
  assert.equal(secondNextCalls, 0);
});

it("invalidates by tag and forces MISS on the next request", async () => {
  const { invalidate, onRequest } = provider;

  await onRequest(createContext("https://example.com/news"), async () => {
    return new Response("news-v1", {
      headers: {
        "CDN-Cache-Control": "max-age=60",
        "Cache-Tag": "news",
      },
    });
  });

  await invalidate({ tags: "news" });

  let nextCalls = 0;
  const response = await onRequest(
    createContext("https://example.com/news"),
    async () => {
      nextCalls += 1;
      return new Response("news-v2", {
        headers: {
          "CDN-Cache-Control": "max-age=60",
          "Cache-Tag": "news",
        },
      });
    },
  );

  assert.equal(response.headers.get("X-Astro-Cache"), "MISS");
  assert.equal(await response.text(), "news-v2");
  assert.equal(nextCalls, 1);
});

it("bypasses cache for non-GET methods", async () => {
  const { provider: isolated, close } = await createIsolatedProvider("non-get");
  try {
    let calls = 0;
    const response = await isolated.onRequest(
      createContext("https://example.com/form", { method: "POST" }),
      async () => {
        calls += 1;
        return new Response("ok", {
          headers: {
            "CDN-Cache-Control": "max-age=60",
          },
        });
      },
    );

    assert.equal(calls, 1);
    assert.equal(response.headers.get("X-Astro-Cache"), null);
  } finally {
    await close();
  }
});

it("calls downstream only once when cache write path fails", async () => {
  const { provider: isolated, close } = await createIsolatedProvider(
    "single-next-on-error",
  );
  try {
    let calls = 0;
    await isolated.onRequest(
      createContext("https://example.com/once"),
      async () => {
        calls += 1;
        const response = new Response("body-used", {
          headers: {
            "CDN-Cache-Control": "max-age=60",
          },
        });
        await response.text();
        return response;
      },
    );

    assert.equal(calls, 1);
  } finally {
    await close();
  }
});

it("invalidates by path and forces MISS on next request", async () => {
  const { provider: isolated, close } =
    await createIsolatedProvider("path-invalidate");
  try {
    const target = "https://example.com/docs?b=2&a=1";
    await isolated.onRequest(createContext(target), async () => {
      return new Response("docs-v1", {
        headers: {
          "CDN-Cache-Control": "max-age=60",
        },
      });
    });

    await isolated.invalidate({ path: "/docs?a=1&b=2" });

    let calls = 0;
    const response = await isolated.onRequest(
      createContext(target),
      async () => {
        calls += 1;
        return new Response("docs-v2", {
          headers: {
            "CDN-Cache-Control": "max-age=60",
          },
        });
      },
    );

    assert.equal(response.headers.get("X-Astro-Cache"), "MISS");
    assert.equal(await response.text(), "docs-v2");
    assert.equal(calls, 1);
  } finally {
    await close();
  }
});

it("supports Vary and keeps variants separated", async () => {
  const { provider: isolated, close } = await createIsolatedProvider("vary");
  try {
    const url = "https://example.com/i18n";

    const first = await isolated.onRequest(
      createContext(url, { headers: { "accept-language": "en" } }),
      async () =>
        new Response("hello", {
          headers: {
            "CDN-Cache-Control": "max-age=60",
            Vary: "Accept-Language",
          },
        }),
    );
    assert.equal(first.headers.get("X-Astro-Cache"), "MISS");

    const second = await isolated.onRequest(
      createContext(url, { headers: { "accept-language": "fr" } }),
      async () =>
        new Response("bonjour", {
          headers: {
            "CDN-Cache-Control": "max-age=60",
            Vary: "Accept-Language",
          },
        }),
    );
    assert.equal(second.headers.get("X-Astro-Cache"), "MISS");

    const third = await isolated.onRequest(
      createContext(url, { headers: { "accept-language": "en" } }),
      async () => new Response("unexpected"),
    );
    assert.equal(third.headers.get("X-Astro-Cache"), "HIT");
    assert.equal(await third.text(), "hello");
  } finally {
    await close();
  }
});

it("respects Vary: Cookie by default", async () => {
  const { provider: isolated, close } =
    await createIsolatedProvider("vary-cookie");
  try {
    const url = "https://example.com/profile";

    const first = await isolated.onRequest(
      createContext(url, { headers: { cookie: "sid=a" } }),
      async () =>
        new Response("profile-a", {
          headers: {
            "CDN-Cache-Control": "max-age=60",
            Vary: "Cookie",
          },
        }),
    );
    assert.equal(first.headers.get("X-Astro-Cache"), "MISS");

    const second = await isolated.onRequest(
      createContext(url, { headers: { cookie: "sid=b" } }),
      async () =>
        new Response("profile-b", {
          headers: {
            "CDN-Cache-Control": "max-age=60",
            Vary: "Cookie",
          },
        }),
    );
    assert.equal(second.headers.get("X-Astro-Cache"), "MISS");

    const third = await isolated.onRequest(
      createContext(url, { headers: { cookie: "sid=a" } }),
      async () => new Response("unexpected"),
    );
    assert.equal(third.headers.get("X-Astro-Cache"), "HIT");
    assert.equal(await third.text(), "profile-a");
  } finally {
    await close();
  }
});

it("allows ignoring Vary: Cookie when configured", async () => {
  const isolated = createRedisCacheProvider({
    url: REDIS_URL,
    keyPrefix: uniquePrefix("vary-cookie-ignored"),
    ignoredVaryHeaders: ["cookie"],
  });
  try {
    if (!isolated.onRequest) {
      throw new Error("Expected provider.onRequest to be defined");
    }

    const url = "https://example.com/profile";
    let calls = 0;

    const first = await isolated.onRequest(
      createContext(url, { headers: { cookie: "sid=a" } }),
      async () => {
        calls += 1;
        return new Response("profile-a", {
          headers: {
            "CDN-Cache-Control": "max-age=60",
            Vary: "Cookie",
          },
        });
      },
    );
    assert.equal(first.headers.get("X-Astro-Cache"), "MISS");

    const second = await isolated.onRequest(
      createContext(url, { headers: { cookie: "sid=b" } }),
      async () => {
        calls += 1;
        return new Response("profile-b", {
          headers: {
            "CDN-Cache-Control": "max-age=60",
            Vary: "Cookie",
          },
        });
      },
    );
    assert.equal(second.headers.get("X-Astro-Cache"), "HIT");
    assert.equal(await second.text(), "profile-a");
    assert.equal(calls, 1);
  } finally {
    await isolated.close();
  }
});

it("skips cache when Set-Cookie is present", async () => {
  const { provider: isolated, close } =
    await createIsolatedProvider("set-cookie");
  try {
    const url = "https://example.com/session";
    let calls = 0;

    const first = await isolated.onRequest(createContext(url), async () => {
      calls += 1;
      return new Response("a", {
        headers: {
          "CDN-Cache-Control": "max-age=60",
          "Set-Cookie": "sid=abc; Path=/",
        },
      });
    });
    assert.equal(first.headers.get("X-Astro-Cache"), null);

    const second = await isolated.onRequest(createContext(url), async () => {
      calls += 1;
      return new Response("b", {
        headers: {
          "CDN-Cache-Control": "max-age=60",
          "Set-Cookie": "sid=def; Path=/",
        },
      });
    });
    assert.equal(second.headers.get("X-Astro-Cache"), null);
    assert.equal(await second.text(), "b");
    assert.equal(calls, 2);
  } finally {
    await close();
  }
});

it("returns STALE and revalidates in background", async () => {
  const { provider: isolated, close } = await createIsolatedProvider("stale");
  try {
    const url = "https://example.com/stale";

    await isolated.onRequest(createContext(url), async () => {
      return new Response("v1", {
        headers: {
          "CDN-Cache-Control": "max-age=1, stale-while-revalidate=30",
        },
      });
    });

    // Runtime age checks are second-granularity; >2s avoids boundary flakiness.
    await new Promise((resolve) => setTimeout(resolve, 2200));

    let waitUntilPromise: Promise<unknown> | undefined;
    const staleContext = createContext(url) as {
      request: Request;
      url: URL;
      waitUntil?: (promise: Promise<unknown>) => void;
    };
    staleContext.waitUntil = (promise: Promise<unknown>) => {
      waitUntilPromise = promise;
    };

    const stale = await isolated.onRequest(
      staleContext,
      async () =>
        new Response("v2", {
          headers: {
            "CDN-Cache-Control": "max-age=60, stale-while-revalidate=30",
          },
        }),
    );

    assert.equal(stale.headers.get("X-Astro-Cache"), "STALE");
    assert.equal(await stale.text(), "v1");
    assert.ok(waitUntilPromise);
    await waitUntilPromise;

    const fresh = await isolated.onRequest(createContext(url), async () => {
      return new Response("should-not-be-used");
    });
    assert.equal(fresh.headers.get("X-Astro-Cache"), "HIT");
    assert.equal(await fresh.text(), "v2");
  } finally {
    await close();
  }
});

it("falls back to MISS when stored entry payload is invalid", async () => {
  const prefix = uniquePrefix("bad-payload");
  const isolated = createRedisCacheProvider({
    url: REDIS_URL,
    keyPrefix: prefix,
  });
  if (!isolated.onRequest) {
    throw new Error("Expected provider.onRequest to be defined");
  }

  const client = createClient({ url: REDIS_URL }).withTypeMapping({
    [RESP_TYPES.BLOB_STRING]: Buffer,
  });
  await client.connect();

  try {
    const url = "https://example.com/broken";
    const fullKey = `${prefix.endsWith(":") ? prefix : `${prefix}:`}v1:entry:${hash(cacheKeyFor(url))}`;
    await client.set(fullKey, Buffer.from([0, 1, 2, 3]), { EX: 60 });

    let calls = 0;
    const response = await isolated.onRequest(createContext(url), async () => {
      calls += 1;
      return new Response("regenerated", {
        headers: {
          "CDN-Cache-Control": "max-age=60",
        },
      });
    });

    assert.equal(response.headers.get("X-Astro-Cache"), "MISS");
    assert.equal(await response.text(), "regenerated");
    assert.equal(calls, 1);
  } finally {
    await isolated.close();
    await client.close();
  }
});

it("sets TTL on index keys and keeps longer TTL for shared tags", async () => {
  const keyPrefix = uniquePrefix("index-ttl");
  const isolated = createRedisCacheProvider({
    url: REDIS_URL,
    keyPrefix,
  });
  if (!isolated.onRequest) {
    throw new Error("Expected provider.onRequest to be defined");
  }

  const client = createClient({ url: REDIS_URL });
  await client.connect();

  try {
    const sharedTag = "shared-ttl-tag";
    await isolated.onRequest(
      createContext("https://example.com/ttl-long"),
      async () => {
        return new Response("long", {
          headers: {
            "CDN-Cache-Control": "max-age=120",
            "Cache-Tag": sharedTag,
          },
        });
      },
    );

    const pathIndexLong = buildPathIndexKey(keyPrefix, "/ttl-long");
    const tagIndex = buildTagIndexKey(keyPrefix, sharedTag);

    const firstPathTtl = await client.ttl(pathIndexLong);
    const firstTagTtl = await client.ttl(tagIndex);
    assert.ok(firstPathTtl > 0);
    assert.ok(firstTagTtl > 0);

    await isolated.onRequest(
      createContext("https://example.com/ttl-short"),
      async () => {
        return new Response("short", {
          headers: {
            "CDN-Cache-Control": "max-age=5",
            "Cache-Tag": sharedTag,
          },
        });
      },
    );

    const secondTagTtl = await client.ttl(tagIndex);
    assert.ok(secondTagTtl > 30);
  } finally {
    await isolated.close();
    await client.close();
  }
});
