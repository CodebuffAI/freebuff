import { serve } from 'bun'
import frameworks from './data/frameworks.json'
import cfIps from './data/cloudflare-ips.json'

const PORT = Number(process.env.PORT ?? 3000)

const routes: Record<string, unknown> = {
  '/api/frameworks': frameworks,
  '/api/cloudflare-ips': cfIps,
  '/api/health': { status: 'ok', time: new Date().toISOString() },
}

serve({
  port: PORT,
  hostname: '0.0.0.0',
  fetch(req) {
    const url = new URL(req.url)
    const path = url.pathname.replace(/\/$/, '') || '/'
    if (path === '/' || path === '/index.html') {
      return new Response(
        `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Raw Data Server</title></head><body><h1>Raw Data Server</h1><ul><li><a href="/api/health">/api/health</a></li><li><a href="/api/frameworks">/api/frameworks</a> (${(frameworks as any[]).length} products)</li><li><a href="/api/cloudflare-ips">/api/cloudflare-ips</a></li></ul></body></html>`,
        { headers: { 'content-type': 'text/html; charset=utf-8' } },
      )
    }
    if (path in routes) {
      return new Response(JSON.stringify(routes[path], null, 2), {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })
    }
    return new Response('Not Found', { status: 404 })
  },
})

console.log(`Raw data server listening on http://0.0.0.0:${PORT}`)
console.log(`Preview: http://127.0.0.1:${PORT}/`)
