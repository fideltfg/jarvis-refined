let requestSequence = 0

export function askHiddenSession(
  url: string,
  prompt: string,
  { provider, model, statusOnly = false }: { provider: string; model: string; statusOnly?: boolean },
  Socket: typeof WebSocket = WebSocket,
): Promise<{ text: string }> {
  const target = new URL(url)
  target.searchParams.delete('conversation')
  const socket = new Socket(target.toString())
  const id = `startup-${Date.now()}-${++requestSequence}`

  return new Promise((resolve, reject) => {
    let finished = false
    let requested = false
    let text = ''
    let timer: ReturnType<typeof setTimeout>
    const heartbeat = setInterval(() => {
      if (socket.readyState === Socket.OPEN) socket.send(JSON.stringify({ type: 'ping' }))
    }, 15_000)

    const cleanup = () => {
      finished = true
      clearTimeout(timer)
      clearInterval(heartbeat)
      socket.removeEventListener('message', onMessage)
      socket.removeEventListener('close', onClose)
      socket.removeEventListener('error', onError)
      socket.close()
    }
    const fail = (error: Error) => {
      if (finished) return
      cleanup()
      reject(error)
    }
    const arm = (duration: number) => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        if (socket.readyState === Socket.OPEN && requested && !statusOnly) {
          socket.send(JSON.stringify({ type: 'interrupt' }))
        }
        fail(new Error('The hidden startup session timed out.'))
      }, duration)
    }
    const onMessage = (event: MessageEvent) => {
      let frame
      try { frame = JSON.parse(event.data as string) } catch { return }
      if (frame.type === 'conversation' && !requested) {
        if (frame.status !== 'new') {
          fail(new Error('The bridge could not open a fresh startup session.'))
          return
        }
        requested = true
        arm(120_000)
        try {
          socket.send(JSON.stringify(statusOnly
            ? { type: 'startup_status', requestId: id }
            : { type: 'ask', id, text: prompt, provider, model }))
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)))
        }
        return
      }
      if (!requested) return
      if (statusOnly && frame.type === 'startup_status_reply' && frame.requestId === id) {
        cleanup()
        resolve({ text: JSON.stringify(frame.snapshot) })
        return
      }
      if (frame.type === 'capture' && typeof frame.id === 'string') {
        socket.send(JSON.stringify({ type: 'reply', id: frame.id, error: 'Camera access is unavailable in a hidden startup session.' }))
        return
      }
      if (frame.ask !== id) return
      if (['text', 'tool', 'progress', 'thinking'].includes(frame.type)) arm(120_000)
      if (frame.type === 'text') text += frame.delta ?? ''
      else if (frame.type === 'done') {
        cleanup()
        resolve({ text: (text || frame.text || '').trim() })
      } else if (frame.type === 'error') {
        fail(new Error(frame.message ?? 'The hidden startup session failed.'))
      }
    }
    const onClose = () => fail(new Error('The hidden startup session disconnected.'))
    const onError = () => fail(new Error('The hidden startup session connection failed.'))
    socket.addEventListener('message', onMessage)
    socket.addEventListener('close', onClose)
    socket.addEventListener('error', onError)
    arm(6000)
  })
}