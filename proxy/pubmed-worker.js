/**
 * Scholea — thin PubMed proxy (Cloudflare Worker).
 *
 * PubMed E-utilities are not CORS-enabled, so the web build can't call them
 * directly. This tiny worker forwards `/entrez/eutils/*` to NCBI and adds CORS
 * headers. Deploy it (see proxy/README.md), then paste its URL into
 * Settings → Literature sources → PubMed proxy URL.
 *
 * It forwards ONLY the read-only E-utilities paths and passes query strings
 * (including any BYO api_key) straight through — it stores nothing.
 */
const NCBI = "https://eutils.ncbi.nlm.nih.gov";
const ALLOWED = /^\/entrez\/eutils\/(esearch|esummary|efetch|einfo|elink)\.fcgi$/;

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: cors });

    const url = new URL(request.url);
    if (!ALLOWED.test(url.pathname)) {
      return new Response("Not found", { status: 404, headers: cors });
    }

    const upstream = new URL(NCBI + url.pathname + url.search);
    const res = await fetch(upstream, { headers: { accept: "application/json" } });
    const body = await res.arrayBuffer();
    return new Response(body, {
      status: res.status,
      headers: {
        ...cors,
        "content-type": res.headers.get("content-type") ?? "application/json",
        "cache-control": "public, max-age=300",
      },
    });
  },
};
