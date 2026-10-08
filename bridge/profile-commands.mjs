import { z } from 'zod'
import { profileChanges, profileInput } from '../agents/profiles.mjs'

const identifier = z.string().regex(/^p_[a-z0-9]+$/).max(100)
const request = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }),
  z.object({ action: z.literal('create'), profile: profileInput }),
  z.object({ action: z.literal('update'), profileId: identifier, changes: profileChanges }),
  z.object({ action: z.literal('delete'), profileId: identifier }),
  z.object({ action: z.literal('run'), profileId: identifier }),
])

export async function handleProfileRequest(message, api, send) {
  if (message.type !== 'profile_request') return false
  if (typeof message.requestId !== 'string' || !message.requestId || message.requestId.length > 100) return true
  const reply = (body) => send({ type: 'profile_reply', requestId: message.requestId, ...body })
  try {
    if (!api) throw new Error('Background agents are disabled.')
    const parsed = request.parse(message)
    let result
    if (parsed.action === 'list') result = await api.profiles()
    else if (parsed.action === 'create') result = await api.createProfile(parsed.profile)
    else if (parsed.action === 'update') result = await api.updateProfile(parsed.profileId, parsed.changes)
    else if (parsed.action === 'delete') result = await api.deleteProfile(parsed.profileId)
    else result = await api.runProfile(parsed.profileId)
    reply({ result })
  } catch (err) { reply({ error: String(err.message ?? err) }) }
  return true
}