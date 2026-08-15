import test from 'node:test'
import assert from 'node:assert/strict'

import { add, subtract, multiply } from './math.js'

test('add returns the sum of two positive integers', () => {
  assert.equal(add(2, 3), 5)
})

test('add handles negative numbers', () => {
  assert.equal(add(-2, 5), 3)
  assert.equal(add(-2, -5), -7)
})

test('add handles decimal values', () => {
  assert.equal(add(0.1, 0.2), 0.30000000000000004)
})

test('subtract returns the difference of two integers', () => {
  assert.equal(subtract(7, 4), 3)
})

test('subtract handles negative results and negative operands', () => {
  assert.equal(subtract(2, 5), -3)
  assert.equal(subtract(-2, -5), 3)
})

test('multiply returns the product of two positive integers', () => {
  assert.equal(multiply(6, 7), 42)
})

test('multiply handles zero and negative operands', () => {
  assert.equal(multiply(0, 99), 0)
  assert.equal(multiply(-3, 4), -12)
  assert.equal(multiply(-3, -4), 12)
})

test('multiply handles decimal values', () => {
  assert.equal(multiply(0.1, 0.2), 0.020000000000000004)
})
