# PubMed proxy (web build only)

PubMed E-utilities aren't CORS-enabled, so a browser can't call them directly.
The **desktop (Tauri) build needs no proxy**: its HTTP client bypasses CORS.
For the **web build**, deploy this tiny [`pubmed-worker.js`](./pubmed-worker.js)
and point Scholea at it.

It forwards only the read-only E-utilities endpoints (`esearch`, `esummary`,
`efetch`, `einfo`, `elink`), passes query strings through (including any BYO NCBI
`api_key`), adds CORS headers, and stores nothing.

## Deploy (Cloudflare Workers, free tier)

```bash
npm i -g wrangler
wrangler deploy proxy/pubmed-worker.js --name scholea-pubmed
# → https://scholea-pubmed.<your-subdomain>.workers.dev
```

Then in Scholea: **Settings → Literature sources → PubMed → PubMed proxy URL**,
paste the worker URL. PubMed becomes selectable in the web Search tool.

## How Scholea uses it

The app requests `"<proxyBase>/entrez/eutils/esearch.fcgi?..."`. Any host that
forwards that path to `https://eutils.ncbi.nlm.nih.gov` with CORS headers works
(Cloudflare Workers, a Netlify/Vercel function, or your own reverse proxy). This
worker is just the smallest reference implementation.

> Be a good NCBI citizen: keep a contact email set in Settings, add a free NCBI
> API key for higher limits, and don't hammer the endpoint.
