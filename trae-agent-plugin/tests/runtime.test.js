const assert = require('node:assert/strict')
const test = require('node:test')

async function runtime() {
  return import('../bin/runtime.mjs')
}

function req({ addr = '127.0.0.1', host = '127.0.0.1:41730', header = '' } = {}) {
  return {
    socket: { remoteAddress: addr },
    headers: { host, ...(header === '' ? {} : { 'x-agent-status-token': header }) },
  }
}

function url(query = '') {
  return new URL(`http://127.0.0.1:41730/nebula-screen/screen${query}`)
}

test('token is accepted from query or header, and rejected otherwise', async () => {
  const { authorized, newToken } = await runtime()
  const token = newToken()

  assert.equal(authorized(req(), url(`?token=${token}`), token), true)
  assert.equal(authorized(req({ header: token }), url(), token), true)
  assert.equal(authorized(req(), url('?token=wrong'), token), false)
  assert.equal(authorized(req({ header: 'wrong' }), url(), token), false)
  assert.equal(authorized(req(), url(), token), false)
})

test('non-loopback sockets and foreign Host headers are rejected', async () => {
  const { authorized, isLoopback, newToken } = await runtime()
  const token = newToken()

  assert.equal(isLoopback(req()), true)
  assert.equal(isLoopback(req({ addr: '192.168.1.9' })), false)
  assert.equal(isLoopback(req({ host: 'evil.example:41730' })), false)
  assert.equal(authorized(req({ addr: '192.168.1.9' }), url(`?token=${token}`), token), false)
  assert.equal(authorized(req({ host: 'evil.example:41730' }), url(`?token=${token}`), token), false)
})
