import { createServer } from "node:http"

const port = Number(process.env.PLAYWRIGHT_API_PORT ?? 3199)

createServer(async (req, res) => {
  if (req.url === "/health") {
    res.writeHead(200).end("ok")
    return
  }
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (req.url === "/v1/proxy-redirect") {
    res.writeHead(302, {
      location: "/dashboard?proxied=1",
      "set-cookie": ["proxy_a=1; Path=/; HttpOnly", "proxy_b=2; Path=/; SameSite=Lax"],
    }).end()
    return
  }
  res.writeHead(200, { "content-type": "application/json", "x-ratelimit-remaining": "7" }).end(JSON.stringify({
    method: req.method,
    url: req.url,
    body: Buffer.concat(chunks).toString("utf8"),
    origin: req.headers.origin,
    forwardedHost: req.headers["x-forwarded-host"],
  }))
}).listen(port, "127.0.0.1")
