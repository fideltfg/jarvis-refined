import type { Panel } from '../store'

export function createStartupAgentBriefing({
  usingBridge,
  restore,
  runHidden,
  publish,
  announce = () => {},
}: {
  usingBridge: boolean
  restore: () => Promise<unknown>
  runHidden: () => Promise<{ text: string; summary?: string; html?: string }>
  publish: (panel: Panel) => void
  announce?: (text: string) => void
}) {
  let started = false
  return async () => {
    if (!usingBridge || started) return
    await restore()
    if (started) return
    started = true
    const report = (text: string, accent: Panel['accent'] = 'default', html?: string) => {
      const escaped = text.replace(/[&<>"']/g, (character) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      })[character]!)
      publish({
        id: 'startup-agent-briefing', title: 'Startup Agent Briefing',
        html: html || `<div style="white-space:pre-wrap">${escaped}</div>`,
        anim: 'materialise', slot: 'right', accent, hold: 'sticky',
      })
    }
    report('Checking previous subagents and background or remote agent work...')
    try {
      const result = await runHidden()
      const text = result.text.trim() || 'The startup check finished without a report. Agent status could not be confirmed.'
      report(text, result.text.trim() ? 'default' : 'amber', result.html)
      announce(result.summary?.trim() || text)
    } catch (error) {
      const text = `Startup check failed: ${error instanceof Error ? error.message : String(error)}`
      report(text, 'red')
      announce(text)
      throw error
    }
  }
}

export function createStartupAnnouncement({
  canSpeak,
  speak,
  onError,
}: {
  canSpeak: () => boolean
  speak: (text: string) => Promise<void>
  onError: (error: unknown) => void
}) {
  let pending = ''
  let speaking = false
  const flush = () => {
    if (!pending || speaking || !canSpeak()) return
    const text = pending
    pending = ''
    speaking = true
    void Promise.resolve().then(() => {
      if (!canSpeak()) {
        pending = pending || text
        return
      }
      return speak(text)
    }).catch(onError).finally(() => {
      speaking = false
      flush()
    })
  }
  return {
    enqueue(text: string) {
      pending = text.trim()
      flush()
    },
    flush,
  }
}