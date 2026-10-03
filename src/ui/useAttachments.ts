import { useCallback, useEffect, useRef, useState, type ChangeEvent, type ClipboardEvent } from 'react'
import { readAttachments, type Attachment } from '../lib/attachments'
import { useStore } from '../store'

const hasFiles = (event: DragEvent) => Boolean(event.dataTransfer?.types.includes('Files'))

/**
 * Attachments for a chat composer: paste, drop anywhere on the page, or pick.
 * Rejections are reported through the store's error line, which every theme shows.
 */
export function useAttachments(enabled: boolean) {
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [reading, setReading] = useState(0)
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const current = useRef(attachments)
  current.current = attachments
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled

  const add = useCallback(async (files: File[]) => {
    if (!files.length) return
    setReading((n) => n + 1)
    try {
      const result = await readAttachments(files, current.current)
      current.current = [...current.current, ...result.attachments]
      setAttachments(current.current)
      if (result.rejected.length) useStore.getState().setError(result.rejected.join(' '))
    } finally {
      setReading((n) => n - 1)
    }
  }, [])

  const remove = useCallback((index: number) => {
    setAttachments((list) => list.filter((_, i) => i !== index))
  }, [])

  const clear = useCallback(() => setAttachments([]), [])

  const onPaste = useCallback((event: ClipboardEvent<HTMLElement>) => {
    const files = [...event.clipboardData.files]
    if (!files.length || !enabledRef.current) return
    event.preventDefault()
    void add(files)
  }, [add])

  useEffect(() => {
    // Counted because dragenter/dragleave fire for every child crossed.
    let depth = 0
    const onEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      depth += 1
      if (enabledRef.current) setDragging(true)
    }
    const onOver = (event: DragEvent) => {
      if (!hasFiles(event)) return
      // Without this the browser navigates to the dropped file and the session is lost.
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = enabledRef.current ? 'copy' : 'none'
    }
    const onLeave = (event: DragEvent) => {
      if (!hasFiles(event)) return
      depth = Math.max(0, depth - 1)
      if (!depth) setDragging(false)
    }
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      depth = 0
      setDragging(false)
      if (enabledRef.current) void add([...(event.dataTransfer?.files ?? [])])
    }
    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragover', onOver)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [add])

  const openPicker = useCallback(() => inputRef.current?.click(), [])

  const pickerProps = {
    ref: inputRef,
    type: 'file',
    multiple: true,
    hidden: true,
    tabIndex: -1,
    onChange: (event: ChangeEvent<HTMLInputElement>) => {
      void add([...(event.target.files ?? [])])
      event.target.value = ''
    },
  } as const

  return { attachments, reading: reading > 0, dragging, add, remove, clear, onPaste, openPicker, pickerProps }
}
