import { hash as nodeHash } from "node:crypto";

import type { CacheProvider } from "astro";
import picomatch from "picomatch";
import { createClient, RESP_TYPES } from "redis";

import { StoredCacheEntry } from "./schemas.js";

export type { RedisCacheProvider, RedisCacheProviderOptions };
export { createRedisCacheProvider, createRedisCacheProvider as default };

const SCHEMA_VERSION = 1;

/**
 * Built-in query parameter patterns excluded from cache keys.
 * @internal
 */
export const DEFAULT_EXCLUDED_PARAMS = [
  "utm_*",
  "fbclid",
  "gclid",
  "gbraid",
  "wbraid",
  "dclid",
  "msclkid",
  "twclid",
  "li_fat_id",
  "mc_cid",
  "mc_eid",
  "_ga",
  "_gl",
  "_hsenc",
  "_hsmi",
  "_ke",
  "oly_anon_id",
  "oly_enc_id",
  "rb_clickid",
  "s_cid",
  "vero_id",
  "wickedid",
  "yclid",
  "__s",
  "ref",
] as const;

/**
 * Query string normalization settings for cache key generation.
 *
 * `include` and `exclude` are mutually exclusive.
 */
export interface QueryConfigInput {
  /**
   * Only these query parameter names are included in cache keys.
   * @default undefined
   */
  include?: string[];

  /**
   * Query parameter names or glob patterns excluded from cache keys.
   * @default {@link DEFAULT_EXCLUDED_PARAMS}
   */
  exclude?: string[];

  /**
   * Sorts query parameters before key generation for stable cache keys.
   * @default true
   */
  sort?: boolean;
}

interface QueryConfig {
  include: string[] | null;
  excludeMatcher: ((key: string) => boolean) | null;
  sort: boolean;
}

type RedisClient = ReturnType<typeof createClientWithTypeMapping>;

/**
 * Configuration for the Redis cache provider.
 */
interface RedisCacheProviderOptions {
  /**
   * Redis connection URL or runtime resolver for values unavailable at build time.
   * @default undefined
   */
  url?: string | (() => string | undefined);

  /**
   * Prefix used for all cache keys stored in Redis.
   * @default "astro:cache"
   */
  keyPrefix?: string;

  /**
   * Query string normalization rules used when building cache keys.
   * @default undefined
   */
  query?: QueryConfigInput;

  /**
   * Lock TTL in seconds for stale-while-revalidate background refresh.
   * @default 30
   */
  revalidateLockTtl?: number;

  /**
   * Additional `Vary` header names to ignore during cache key matching.
   * `set-cookie` is always ignored.
   *
   * @default []
   */
  ignoredVaryHeaders?: Iterable<string>;
}

/**
 * Astro cache provider implementation with an explicit shutdown hook.
 */
interface RedisCacheProvider extends CacheProvider {
  /** Closes the Redis client connection used by the provider instance. */
  close(): Promise<void>;
}

function createClientWithTypeMapping(url: string | undefined) {
  return createClient({ url }).withTypeMapping({
    [RESP_TYPES.BLOB_STRING]: Buffer,
  });
}

function parseCdnCacheControl(header: string | null): {
  maxAge: number;
  swr: number;
} {
  let maxAge = 0;
  let swr = 0;
  if (!header) {
    return { maxAge, swr };
  }

  for (const part of header.split(",")) {
    const trimmed = part.trim().toLowerCase();
    if (trimmed.startsWith("max-age=")) {
      maxAge = Number.parseInt(trimmed.slice(8), 10) || 0;
      continue;
    }
    if (trimmed.startsWith("stale-while-revalidate=")) {
      swr = Number.parseInt(trimmed.slice(23), 10) || 0;
    }
  }

  return { maxAge, swr };
}

function parseCacheTags(header: string | null): string[] {
  const tags = [];

  if (header) {
    for (let tag of header.split(",")) {
      tag = tag.trim();
      if (tag) {
        tags.push(tag);
      }
    }
  }

  return tags;
}

function parseVaryHeader(
  response: Response,
  ignoredVaryHeaders: ReadonlySet<string>,
): string[] {
  const vary = response.headers.get("Vary");
  if (!vary || vary.trim() === "*") {
    return [];
  }

  return vary
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0 && !ignoredVaryHeaders.has(h));
}

function matchesVary(request: Request, entry: StoredCacheEntry): boolean {
  if (!entry.vary.length) {
    return true;
  }
  for (const header of entry.vary) {
    const requestValue = request.headers.get(header) ?? "";
    if (requestValue !== entry.varyValues.get(header)) {
      return false;
    }
  }
  return true;
}

function buildVarySuffix(request: Request, varyHeaders: string[]): string {
  if (varyHeaders.length === 0) {
    return "";
  }
  const parts: string[] = [];
  for (const header of varyHeaders) {
    parts.push(`${header}=${request.headers.get(header) ?? ""}`);
  }
  return `\0${parts.join("\0")}`;
}

function encodeVaryHeaders(varyHeaders: string[]): string {
  return varyHeaders.join(",");
}

function decodeVaryHeaders(raw: Buffer): string[] {
  return raw.toString("utf8").split(",");
}

function normalizeQueryConfig({
  include,
  exclude,
  sort = true,
}: QueryConfigInput = {}): QueryConfig {
  if (include && exclude) {
    throw new Error(
      "`query.include` and `query.exclude` cannot be used together.",
    );
  }

  const excludePatterns = include
    ? []
    : (exclude ?? [...DEFAULT_EXCLUDED_PARAMS]);
  const excludeMatcher =
    excludePatterns.length > 0
      ? picomatch(excludePatterns, { nocase: true })
      : null;

  return { include: include ?? null, excludeMatcher, sort };
}

function buildQueryString(url: URL, config: QueryConfig): string {
  const params = new URLSearchParams(url.searchParams);

  if (config.include) {
    const allowed = new Set(config.include);
    for (const key of Array.from(params.keys())) {
      if (!allowed.has(key)) {
        params.delete(key);
      }
    }
  }

  if (config.excludeMatcher) {
    for (const key of Array.from(params.keys())) {
      if (config.excludeMatcher(key)) {
        params.delete(key);
      }
    }
  }

  if (config.sort) {
    params.sort();
  }

  const queryString = params.toString();
  return queryString ? `?${queryString}` : "";
}

function getCachePrimaryKey(url: URL, queryConfig: QueryConfig): string {
  return `${url.origin}${url.pathname}${buildQueryString(url, queryConfig)}`;
}

function getCachePath(url: URL, queryConfig: QueryConfig): string {
  return `${url.pathname}${buildQueryString(url, queryConfig)}`;
}

function hash(value: string): string {
  return nodeHash("sha256", value, "hex");
}

function normalizeKeyPrefix(value: string | undefined): string {
  const prefix = value?.trim() || "astro:cache";
  return prefix.endsWith(":") ? prefix : `${prefix}:`;
}

function buildEntryKey(prefix: string, cacheKey: string): string {
  return `${prefix}v${SCHEMA_VERSION}:entry:${hash(cacheKey)}`;
}

function buildVaryKey(prefix: string, primaryKey: string): string {
  return `${prefix}v${SCHEMA_VERSION}:vary:${hash(primaryKey)}`;
}

function buildPathIndexKey(prefix: string, path: string): string {
  return `${prefix}v${SCHEMA_VERSION}:idx:path:${hash(path)}`;
}

function buildTagIndexKey(prefix: string, tag: string): string {
  return `${prefix}v${SCHEMA_VERSION}:idx:tag:${hash(tag)}`;
}

function buildRevalidateLockKey(prefix: string, cacheKey: string): string {
  return `${prefix}v${SCHEMA_VERSION}:lock:${hash(cacheKey)}`;
}

function warn(message: string): void {
  console.warn(`[astro:cache:redis] ${message}`);
}

function getCacheFreshness(
  entry: StoredCacheEntry,
): "fresh" | "stale" | "expired" {
  const ageSeconds = Math.floor((Date.now() - entry.storedAt.getTime()) / 1000);
  if (ageSeconds <= entry.maxAge) {
    return "fresh";
  }
  if (ageSeconds <= entry.maxAge + entry.swr) {
    return "stale";
  }
  return "expired";
}

function createResponseFromEntry(entry: StoredCacheEntry): Response {
  const headers = new Headers(
    entry.headers as unknown as Record<string, string>,
  );
  const body = Buffer.from(entry.body);
  return new Response(body, {
    status: entry.status,
    headers,
  });
}

function parseStoredEntry(raw: Buffer | null): StoredCacheEntry | null {
  if (!raw) {
    return null;
  }

  try {
    return StoredCacheEntry.decode(raw);
  } catch {
    return null;
  }
}

async function serializeResponse(
  response: Response,
  request: Request,
  path: string,
  maxAge: number,
  swr: number,
  tags: string[],
  ignoredVaryHeaders: ReadonlySet<string>,
): Promise<StoredCacheEntry> {
  const bodyBuffer = await response.arrayBuffer();
  const bodyBytes = new Uint8Array(bodyBuffer);

  const headers = new Map();
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() !== "set-cookie") {
      headers.set(key, value);
    }
  });

  const vary = parseVaryHeader(response, ignoredVaryHeaders);
  const varyValues = new Map();
  for (const header of vary) {
    const value = request.headers.get(header) ?? "";
    varyValues.set(header, value);
  }

  return {
    status: response.status,
    headers,
    body: bodyBytes,
    storedAt: new Date(),
    maxAge,
    swr,
    tags: Array.from(new Set(tags)),
    path,
    vary,
    varyValues,
  };
}

/**
 * Creates a Redis-backed cache provider for Astro route caching.
 */
function createRedisCacheProvider(
  config: RedisCacheProviderOptions = {},
): RedisCacheProvider {
  const keyPrefix = normalizeKeyPrefix(config?.keyPrefix);
  const queryConfig = normalizeQueryConfig(config?.query);
  const lockTtlSeconds = Math.max(5, config?.revalidateLockTtl ?? 30);
  const ignoredVaryHeaders = new Set(["set-cookie"]);

  const extraIgnoredVaryHeaders = config?.ignoredVaryHeaders;
  if (extraIgnoredVaryHeaders) {
    for (const header of extraIgnoredVaryHeaders) {
      const normalized = header.trim().toLocaleLowerCase();
      if (normalized.length > 0) {
        ignoredVaryHeaders.add(normalized);
      }
    }
  }

  let clientPromise: Promise<RedisClient> | undefined;

  const getClient = (): Promise<RedisClient> => {
    if (clientPromise) {
      return clientPromise;
    }

    let redisUrl = config?.url;
    if (typeof redisUrl === "function") {
      redisUrl = redisUrl();
    }

    const client = createClientWithTypeMapping(redisUrl);
    client.on("error", (error) => {
      warn(`Redis client error: ${String(error)}`);
    });

    const pending = client
      .connect()
      .then(() => client)
      .catch((error) => {
        clientPromise = undefined;
        throw error;
      });
    clientPromise = pending;

    return pending;
  };

  const deleteEntry = async (
    client: RedisClient,
    key: string,
  ): Promise<void> => {
    const existing = parseStoredEntry(await client.get(key));
    const multi = client.multi();
    multi.del(key);

    if (existing) {
      multi.sRem(buildPathIndexKey(keyPrefix, existing.path), key);
      for (const tag of existing.tags) {
        multi.sRem(buildTagIndexKey(keyPrefix, tag), key);
      }
    }

    await multi.exec();
  };

  const storeEntry = async (
    client: RedisClient,
    key: string,
    primaryKey: string,
    entry: StoredCacheEntry,
  ): Promise<void> => {
    const existing = parseStoredEntry(await client.get(key));
    const ttl = Math.max(1, Math.ceil(entry.maxAge + entry.swr));
    const multi = client.multi();

    multi.set(key, Buffer.from(StoredCacheEntry.encode(entry)), { EX: ttl });
    const varyKey = buildVaryKey(keyPrefix, primaryKey);
    if (entry.vary.length) {
      multi.set(varyKey, encodeVaryHeaders(entry.vary));
    } else {
      multi.del(varyKey);
    }

    if (existing) {
      multi.sRem(buildPathIndexKey(keyPrefix, existing.path), key);
      for (const tag of existing.tags) {
        multi.sRem(buildTagIndexKey(keyPrefix, tag), key);
      }
    }

    const pathIndexKey = buildPathIndexKey(keyPrefix, entry.path);
    multi.sAdd(pathIndexKey, key);
    multi.expire(pathIndexKey, ttl, "NX");
    multi.expire(pathIndexKey, ttl, "GT");
    for (const tag of entry.tags) {
      const tagIndexKey = buildTagIndexKey(keyPrefix, tag);
      multi.sAdd(tagIndexKey, key);
      multi.expire(tagIndexKey, ttl, "NX");
      multi.expire(tagIndexKey, ttl, "GT");
    }

    await multi.exec();
  };

  const loadKnownVaryHeaders = async (
    client: RedisClient,
    primaryKey: string,
  ): Promise<string[] | undefined> => {
    const raw = await client.get(buildVaryKey(keyPrefix, primaryKey));
    return raw ? decodeVaryHeaders(raw) : undefined;
  };

  const maybeStoreResponse = async (
    client: RedisClient,
    response: Response,
    request: Request,
    requestUrl: URL,
    primaryKey: string,
  ): Promise<boolean> => {
    const cdnCacheControl = response.headers.get("CDN-Cache-Control");
    const { maxAge, swr } = parseCdnCacheControl(cdnCacheControl);
    if (maxAge <= 0) {
      return false;
    }

    if (response.headers.has("set-cookie")) {
      warn(
        `Skipping cache for ${requestUrl.pathname}${requestUrl.search} because response includes Set-Cookie.`,
      );
      return false;
    }

    const tags = parseCacheTags(response.headers.get("Cache-Tag"));
    const entry = await serializeResponse(
      response,
      request,
      getCachePath(requestUrl, queryConfig),
      maxAge,
      swr,
      tags,
      ignoredVaryHeaders,
    );

    const key = buildEntryKey(
      keyPrefix,
      primaryKey +
        (entry.vary.length ? buildVarySuffix(request, entry.vary) : ""),
    );
    await storeEntry(client, key, primaryKey, entry);

    return true;
  };

  const revalidateInBackground = async (
    client: RedisClient,
    lockKey: string,
    requestUrl: URL,
    request: Request,
    primaryKey: string,
    next: () => Promise<Response>,
  ): Promise<void> => {
    const lock = await client.set(lockKey, "1", {
      NX: true,
      EX: lockTtlSeconds,
    });
    if (lock !== "OK") {
      return;
    }

    try {
      const freshResponse = await next();
      await maybeStoreResponse(
        client,
        freshResponse,
        request,
        requestUrl,
        primaryKey,
      );
    } catch (error) {
      warn(
        `Background revalidation failed for ${requestUrl.pathname}${requestUrl.search}: ${String(error)}`,
      );
    } finally {
      try {
        await client.del(lockKey);
      } catch {
        // Lock expiration is enough when explicit delete fails.
      }
    }
  };

  const invalidateByIndex = async (
    client: RedisClient,
    indexKey: string,
  ): Promise<void> => {
    const keys = await client.sMembers(indexKey);
    for (const key of keys) {
      await deleteEntry(client, key.toString("utf8"));
    }
    await client.del(indexKey);
  };

  return {
    name: "redis",
    async onRequest(context, next) {
      if (context.request.method !== "GET") {
        return next();
      }

      const requestUrl = new URL(context.request.url);
      const primaryKey = getCachePrimaryKey(requestUrl, queryConfig);

      let client: RedisClient;
      try {
        client = await getClient();
      } catch (error) {
        warn(`Redis is unavailable, bypassing cache: ${String(error)}`);
        return next();
      }

      try {
        const knownVary = await loadKnownVaryHeaders(client, primaryKey);
        const lookupKey = buildEntryKey(
          keyPrefix,
          primaryKey +
            (knownVary ? buildVarySuffix(context.request, knownVary) : ""),
        );

        const cachedEntry = parseStoredEntry(await client.get(lookupKey));
        if (cachedEntry && matchesVary(context.request, cachedEntry)) {
          const freshness = getCacheFreshness(cachedEntry);

          if (freshness === "fresh") {
            const response = createResponseFromEntry(cachedEntry);
            response.headers.set("X-Astro-Cache", "HIT");
            return response;
          }

          if (freshness === "stale") {
            const lockKey = buildRevalidateLockKey(keyPrefix, lookupKey);
            const task = revalidateInBackground(
              client,
              lockKey,
              requestUrl,
              context.request,
              primaryKey,
              next,
            );

            const waitUntil = (
              context as {
                waitUntil?: (promise: Promise<unknown>) => void;
              }
            ).waitUntil;

            if (typeof waitUntil === "function") {
              waitUntil(task);
            } else {
              void task;
            }

            const response = createResponseFromEntry(cachedEntry);
            response.headers.set("X-Astro-Cache", "STALE");
            return response;
          }
        }
      } catch (error) {
        warn(`Cache read failed, bypassing cache read path: ${String(error)}`);
        return next();
      }

      const response = await next();
      try {
        const [forCache, forClient] = [response.clone(), response];
        const stored = await maybeStoreResponse(
          client,
          forCache,
          context.request,
          requestUrl,
          primaryKey,
        );
        if (stored) {
          forClient.headers.set("X-Astro-Cache", "MISS");
        }
        return forClient;
      } catch (error) {
        warn(
          `Cache write failed, returning uncached response: ${String(error)}`,
        );
        return response;
      }
    },
    async invalidate(options) {
      const client = await getClient();

      if (options.path) {
        await invalidateByIndex(
          client,
          buildPathIndexKey(keyPrefix, options.path),
        );
      }

      if (options.tags) {
        const tags = Array.isArray(options.tags)
          ? options.tags
          : [options.tags];
        for (const tag of tags) {
          await invalidateByIndex(client, buildTagIndexKey(keyPrefix, tag));
        }
      }
    },
    async close() {
      if (!clientPromise) {
        return;
      }
      try {
        const client = await clientPromise;
        await client.close();
      } catch {
        // Ignore close errors to keep shutdown safe in tests and app exits.
      } finally {
        clientPromise = undefined;
      }
    },
  };
}
