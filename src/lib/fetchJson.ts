/**
 * fetch + JSON, with the failure modes spelled out.
 *
 * A route that throws during module evaluation (rather than inside its
 * handler) never reaches our error formatter — the framework serves an HTML
 * error page instead. Calling `res.json()` on that yields
 * `Unexpected token '<'`, which tells the reader nothing about what broke.
 * Checking the content type first turns it back into a real message.
 */
export async function fetchJson<T>(
  input: RequestInfo,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(input, init);
  const contentType = res.headers.get("content-type") ?? "";

  if (!contentType.includes("application/json")) {
    const body = await res.text();
    throw new Error(
      `Server returned ${res.status} as ${contentType || "an unknown type"} ` +
        `instead of JSON. This usually means the server failed to start up — ` +
        `check the terminal running \`npm run dev\`. ${firstLine(body)}`,
    );
  }

  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Request failed with ${res.status}`);
  return data;
}

/** Pull something human-readable out of an HTML error page, if we can. */
function firstLine(body: string): string {
  const title = body.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim();
  const pre = body.match(/<pre[^>]*>([^<]{0,200})/i)?.[1]?.trim();
  const hint = pre || title;
  return hint ? `Server said: ${hint}` : "";
}
