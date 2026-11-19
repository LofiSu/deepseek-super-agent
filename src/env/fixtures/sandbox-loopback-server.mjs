/**
 * Independent loopback HTTP server for sandbox network probes. Runs outside the
 * probing process so wrapped children can connect while the parent uses spawnSync.
 */
import fs from 'node:fs'
import http from 'node:http'

const portFile = process.argv[2]
if (!portFile) {
  console.error('sandbox-loopback-server: missing port file path')
  process.exit(2)
}

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end('ds-agent-sandbox-net-ok')
})

function shutdown() {
  server.closeAllConnections()
  server.close(() => process.exit(0))
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

server.listen(0, '127.0.0.1', () => {
  const addr = server.address()
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0
  if (port <= 0) {
    console.error('sandbox-loopback-server: bind failed')
    process.exit(1)
  }
  fs.writeFileSync(portFile, String(port), 'utf8')
})
