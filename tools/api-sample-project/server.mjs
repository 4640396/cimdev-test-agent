import { createServer } from 'node:http'

const users = []
const server = createServer((req, res) => {
  res.setHeader('content-type', 'application/json')
  if (req.method === 'GET' && req.url === '/api/health') {
    res.statusCode = 200
    res.end(JSON.stringify({ ok: true }))
    return
  }
  if (req.method === 'GET' && req.url === '/api/users') {
    res.statusCode = 200
    res.end(JSON.stringify(users))
    return
  }
  if (req.method === 'POST' && req.url === '/api/users') {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      users.push(body ? JSON.parse(body) : {})
      res.statusCode = 201
      res.end(JSON.stringify({ created: true }))
    })
    return
  }
  res.statusCode = 404
  res.end(JSON.stringify({ error: 'not found' }))
})
server.listen(8099, '127.0.0.1', () => {
  console.log('API sample listening on 8099')
})
