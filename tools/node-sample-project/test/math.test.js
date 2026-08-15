import test from 'node:test'
import assert from 'node:assert/strict'

function add(a, b) {
  return a + b
}

test('add works', () => {
  assert.equal(add(1, 2), 3)
})

test('subtract works', () => {
  assert.equal(add(5, -2), 3)
})
