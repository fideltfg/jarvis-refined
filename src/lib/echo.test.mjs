import { test } from 'node:test'
import assert from 'node:assert/strict'

import { isEcho, cutsThrough, createHeard } from './echo.ts'

test('his own "no" inside a longer sentence is echo, not an interruption', () => {
  const spoken = 'No, the render failed on the second pass.'
  assert.equal(cutsThrough('no the render failed', spoken), false)
  assert.equal(isEcho('no the render failed', spoken), true)
})

test('a short stop word always cuts through, even one he just said', () => {
  const spoken = 'You should stop the service before upgrading it.'
  for (const heard of ['stop', 'Jarvis stop', 'hold on', 'no']) {
    assert.equal(cutsThrough(heard, spoken), true, heard)
    assert.equal(isEcho(heard, spoken), false, heard)
  }
})

test('a stop word he did not say cuts through at any length', () => {
  const spoken = 'The pricing page is drafted and ready for review.'
  assert.equal(cutsThrough('no wait that is not what I meant', spoken), true)
  assert.equal(isEcho('no wait that is not what I meant', spoken), false)
})

test('a genuine question over him is not echo', () => {
  const spoken = 'The licence server checks keys against the database every hour.'
  assert.equal(isEcho('what about the refund policy', spoken), false)
})

test('echo from the sentence before last is still recognised', () => {
  let t = 0
  const heard = createHeard(() => t)
  heard.say('UnifiGuard watches your gateway for intrusion attempts.')
  t += 3000
  heard.done()
  heard.say('It flags anything unusual.')
  t += 1500
  heard.done()
  heard.say('Reports arrive every morning.')
  assert.equal(isEcho('watches your gateway for intrusion', heard.now()), true)
})

test('the reference lingers after he stops, then clears', () => {
  let t = 0
  const heard = createHeard(() => t)
  heard.say('Deployment finished cleanly.')
  heard.done()
  t += 2500
  assert.match(heard.now(), /Deployment/)
  t += 1000
  assert.equal(heard.now(), '')
})

test('a new answer after the tail does not carry the old one', () => {
  let t = 0
  const heard = createHeard(() => t)
  heard.say('Old answer about invoices.')
  heard.done()
  t += 10_000
  heard.say('New answer about pricing.')
  assert.doesNotMatch(heard.now(), /invoices/)
})

test('the reference is capped to the recent part of a long answer', () => {
  let t = 0
  const heard = createHeard(() => t)
  heard.say('Zebra opening line.')
  for (let i = 0; i < 40; i++) {
    heard.done()
    t += 100
    heard.say(`Filler sentence number ${i} with some words.`)
  }
  assert.doesNotMatch(heard.now(), /Zebra/)
  assert.ok(heard.now().length <= 600)
})

test('his British spelling coming back American is still echo', () => {
  const spoken = 'I have no favourite book, and no library on this machine to read from.'
  assert.equal(isEcho('I have no favorite book', spoken), true)
  assert.equal(isEcho('the colour analysed in the centre', 'The color analyzed in the center.'), true)
})

test('folding spellings does not swallow a real question', () => {
  const spoken = 'The licence server checks keys against the database every hour.'
  assert.equal(isEcho('what is your favourite colour', spoken), false)
  assert.equal(isEcho('open the catalogue instead', spoken), false)
})
