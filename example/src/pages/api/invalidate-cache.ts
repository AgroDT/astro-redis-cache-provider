import type { APIContext } from "astro";
import { DEMO_PATH, DEMO_TAG } from "../../const";

export async function POST(context: APIContext): Promise<Response> {
  context.cache.set(false);

  try {
    await context.cache.invalidate({
      path: DEMO_PATH,
      tags: DEMO_TAG,
    });

    return Response.json(
      {
        ok: true,
        invalidatedAt: new Date().toISOString(),
        path: DEMO_PATH,
        tag: DEMO_TAG,
      },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (error) {
    return Response.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      {
        status: 500,
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  }
}
