import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleScheduleRequest } from './schedule-commands.mjs'
import { handleProfileRequest } from './profile-commands.mjs'

test('schedule commands are validated, allowlisted and acknowledged', async () => {
  const replies = []
  const calls = []
  const api = { createSchedule: async (input) => { calls.push(input); return { id: 's_123' } } }
  const send = (reply) => replies.push(reply)
  await handleScheduleRequest({ type: 'schedule_request', requestId: 'one', action: 'create', input: { title: 'Report', outcome: 'Check services', trigger: { type: 'interval', minutes: 30 } } }, api, send)
  assert.equal(calls.length, 1)
  assert.equal(replies[0].requestId, 'one')
  assert.equal(replies[0].result.id, 's_123')
  await handleScheduleRequest({ type: 'schedule_request', requestId: 'two', action: 'shell' }, api, send)
  assert.ok(replies[1].error)
  await handleScheduleRequest({ type: 'schedule_request', requestId: 'three', action: 'run', id: '../../secret' }, api, send)
  assert.ok(replies[2].error)
  assert.equal(await handleScheduleRequest({ type: 'ask' }, api, send), false)
})

test('disabled and offline services return errors instead of successful replies', async () => {
  const replies = []
  const message = { type: 'schedule_request', requestId: 'one', action: 'list' }
  await handleScheduleRequest(message, null, (reply) => replies.push(reply))
  assert.match(replies[0].error, /disabled/)
  await handleScheduleRequest(message, { schedules: async () => { throw new Error('Service offline') } }, (reply) => replies.push(reply))
  assert.match(replies[1].error, /offline/)
})

test('profile commands validate IDs and route CRUD and run requests', async () => {
  const calls = []
  const replies = []
  const api = {
    profiles: async () => [{ id: 'p_1' }],
    createProfile: async (profile) => { calls.push(['create', profile]); return { id: 'p_2', ...profile } },
    updateProfile: async (id, changes) => { calls.push(['update', id, changes]); return { id, ...changes } },
    deleteProfile: async (id) => { calls.push(['delete', id]); return { id, deleted: true } },
    runProfile: async (id) => { calls.push(['run', id]); return { id: 'g_1', profileId: id } },
  }
  const send = (reply) => replies.push(reply)
  await handleProfileRequest({ type: 'profile_request', requestId: 'list', action: 'list' }, api, send)
  await handleProfileRequest({ type: 'profile_request', requestId: 'create', action: 'create', profile: { name: 'Research', role: 'Analyst', instructions: 'Use public sources.' } }, api, send)
  await handleProfileRequest({ type: 'profile_request', requestId: 'bad', action: 'run', profileId: '../bad' }, api, send)
  await handleProfileRequest({ type: 'profile_request', requestId: 'offline', action: 'delete', profileId: 'p_1' }, null, send)
  assert.deepEqual(replies.map((reply) => reply.requestId), ['list', 'create', 'bad', 'offline'])
  assert.deepEqual(replies[0].result, [{ id: 'p_1' }])
  assert.equal(replies[2].error != null, true)
  assert.match(replies[3].error, /disabled/)
  assert.deepEqual(calls, [['create', { name: 'Research', role: 'Analyst', instructions: 'Use public sources.' }]])
  assert.equal(await handleProfileRequest({ type: 'ask' }, api, send), false)
})

test('the skills a profile may choose from come over the same channel, and an older service answers with none', async () => {
  const replies = []
  const send = (reply) => replies.push(reply)
  const skills = [{ id: 'loose-ends', name: 'loose-ends', description: 'Close out unfinished work.' }]
  await handleProfileRequest({ type: 'profile_request', requestId: 'skills', action: 'skills' }, { skills: async () => skills }, send)
  assert.deepEqual(replies[0].result, skills)
  // A service that predates GET /skills has no skills method; an empty list
  // leaves the picker showing nothing rather than an error over a saved profile.
  await handleProfileRequest({ type: 'profile_request', requestId: 'old', action: 'skills' }, { profiles: async () => [] }, send)
  assert.deepEqual(replies[1].result, [])
  // A selection of skills still has to be names, not paths, to be accepted.
  await handleProfileRequest({
    type: 'profile_request', requestId: 'pathed', action: 'create',
    profile: { name: 'Briefer', role: 'Analyst', instructions: 'Check.', skills: ['/home/me/.claude/skills/loose-ends'] },
  }, { createProfile: async () => assert.fail('a pathed skill must not reach the service') }, send)
  assert.equal(replies[2].error != null, true)
})