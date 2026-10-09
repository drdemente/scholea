/**
 * Turns one HTTP request into one answer. Everything that touches the outside
 * world (verifying the token, the database, the Auth admin API) is passed in,
 * so this file can be tested without a backend.
 *
 * Order of work, which is also the order of the possible refusals:
 *   OPTIONS            answered at once (browser preflight)
 *   405                not a POST
 *   401 unauthenticated  no valid sign-in token
 *   400 invalid_input  the body is not a JSON object, or names no known action
 *   then the action, whose first step is the database deciding what the caller
 *   may do (see actions.ts)
 */
import { type Deps, findAction } from "./actions.ts";
import { HttpError } from "./errors.ts";

/**
 * Browser clients call from another origin (the web app, the desktop app's
 * webview). Authentication is a bearer token, never a cookie, so any origin may
 * ask and no credentials mode is involved.
 */
export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export interface Wiring {
  /** The caller's verified sign-in token. Throws `HttpError` 401 when there is none. */
  verify(req: Request): Promise<string>;
  /** The two connections an action needs, for this caller. */
  connect(token: string): Deps;
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new HttpError(400, "invalid_input", "The request body must be a JSON object.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "invalid_input", "The request body must be a JSON object.");
  }
  return body as Record<string, unknown>;
}

export function createHandler(wiring: Wiring): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

    try {
      if (req.method !== "POST") throw new HttpError(405, "method_not_allowed", "Use POST.");

      const token = await wiring.verify(req);
      const body = await readBody(req);
      const action = findAction(body.action);
      if (!action) throw new HttpError(400, "invalid_input", "Unknown action.");

      const reply = await action(wiring.connect(token), body);
      return json(reply.status, reply.body);
    } catch (e) {
      if (e instanceof HttpError) {
        return json(e.status, e.note ? { error: e.code, message: e.note } : { error: e.code });
      }
      // A bug or an outage. Say nothing about it to the caller.
      console.error("admin: unexpected failure:", e instanceof Error ? `${e.name}: ${e.message}` : typeof e);
      return json(500, { error: "server_error" });
    }
  };
}
