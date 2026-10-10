// Optional relay for the hosted (GitHub Pages) site.
//
// Browsers can't read Songsterr from another website, and public relays come
// and go. Deploying this tiny worker gives the site a reliable route of its
// own. It only forwards GET requests to Songsterr and its tab CDN, so it
// can't be used as a general-purpose proxy.
//
// Deploy on Cloudflare Workers (free plan is plenty):
//   1. dash.cloudflare.com > Workers & Pages > Create > Create Worker
//   2. Replace the code with this file and Deploy.
//   3. Copy the worker URL (https://<name>.<account>.workers.dev) and, in the
//      GitHub repo, add it under Settings > Secrets and variables > Actions >
//      Variables as RELAY_URL. The next deploy picks it up.
// The same file also runs on Deno Deploy and other "export default { fetch }"
// hosts.

const ALLOWED_HOSTS = new Set([
  'www.songsterr.com',
  'songsterr.com',
  'dqsljvtekg760.cloudfront.net',
  'd3d3l6a6rcgkaf.cloudfront.net'
]);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Max-Age': '86400'
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: CORS });

    const target = new URL(request.url).searchParams.get('url');
    let url;
    try {
      url = new URL(target);
    } catch {
      return new Response('Pass ?url=<songsterr address>', { status: 400, headers: CORS });
    }
    if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname)) {
      return new Response('Only Songsterr addresses are relayed', { status: 403, headers: CORS });
    }

    const upstream = await fetch(url.toString(), {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        Accept: '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: 'https://www.songsterr.com/'
      },
      cf: { cacheTtl: 3600, cacheEverything: true }
    });

    const headers = new Headers(CORS);
    headers.set('Content-Type', upstream.headers.get('Content-Type') || 'application/octet-stream');
    headers.set('Cache-Control', 'public, max-age=3600');
    return new Response(upstream.body, { status: upstream.status, headers });
  }
};
