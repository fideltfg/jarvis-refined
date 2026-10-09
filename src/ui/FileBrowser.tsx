import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Download, Eye, FileText, Folder, FolderOpen, RefreshCw, Trash2, X } from 'lucide-react'
import { useStore } from '../store'
import { filesRequest, type WorkFile } from '../lib/bridge'
import { fileUrl, formatSize, TEXT_PREVIEW_LIMIT } from '../lib/files'

/** Format a stored modification time for the file detail tooltip. */
const stamp = (value: string) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))

type TreeNode = { name: string; key: string; folders: Map<string, TreeNode>; files: WorkFile[]; count: number; modified: string }
/** Create one empty folder node for the in-memory file tree. */
const node = (name: string, key: string): TreeNode => ({ name, key, folders: new Map(), files: [], count: 0, modified: '' })

// Drops the fixed `tasks` level under goals; every other area keeps its real folders.
/** Remove the structural task-folder level from displayed goal paths. */
const treeParts = (path: string) => {
  const parts = path.split('/')
  return parts[0] === 'goals' && parts[2] === 'tasks' ? parts.filter((_, index) => index !== 2) : parts
}

/** Build a folder tree with aggregate file counts and newest modification times. */
function buildTree(files: WorkFile[]) {
  const root = node('', '')
  for (const file of files) {
    const parts = treeParts(file.path)
    let cursor = root
    root.count++
    if (file.modified > root.modified) root.modified = file.modified
    for (const part of parts.slice(0, -1)) {
      const key = `${cursor.key}/${part}`
      let next = cursor.folders.get(part)
      if (!next) { next = node(part, key); cursor.folders.set(part, next) }
      next.count++
      if (file.modified > next.modified) next.modified = file.modified
      cursor = next
    }
    cursor.files.push(file)
  }
  return root
}

/** Return expanded-folder keys from the root to the file's parent folder. */
const ancestors = (path: string) => {
  const parts = treeParts(path).slice(0, -1)
  return parts.map((_, index) => `/${parts.slice(0, index + 1).join('/')}`)
}

/** Render a searchable work-file tree with safe preview, download, and deletion. */
export function FileBrowser({ inline = false }: { inline?: boolean }) {
  const open = useStore((state) => state.commandWindow === 'files')
  const panel = useRef<HTMLElement>(null)
  const lock = useRef(false)
  const [files, setFiles] = useState<WorkFile[]>([])
  const [truncated, setTruncated] = useState(false)
  const [canDelete, setCanDelete] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [text, setText] = useState<string | null>(null)
  /** Close the browser through shared command-window state. */
  const close = () => useStore.getState().setCommandWindow(null)

  /** Refresh the file list while preventing overlapping bridge requests. */
  const refresh = useCallback(async () => {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setError('')
    try {
      const result = await filesRequest({ action: 'list' })
      setFiles(result.files)
      setTruncated(result.truncated)
      setCanDelete(result.canDelete)
      setExpanded((current) => current.size || !result.files.length ? current : new Set(ancestors(result.files[0].path).slice(0, 3)))
      setSelected((current) => current && result.files.some((file) => {
        // Keep selection only when the file remains in the refreshed listing.
        return file.path === current
      }) ? current : null)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally { lock.current = false; setBusy(false) }
  }, [])

  useEffect(() => { if (open) void refresh() }, [open, refresh])

  useEffect(() => {
    if (!open) return
    panel.current?.focus()
    /** Handle Escape and trap Tab focus only while the browser is modal. */
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        useStore.getState().setCommandWindow(null)
      } else if (event.key === 'Tab' && !inline) {
        const controls = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href]') ?? [])]
        const first = controls[0]
        const last = controls.at(-1)
        if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, inline])

  const current = files.find((file) => file.path === selected) ?? null
  const previewPath = current?.preview === 'text' ? current.path : null
  const previewSize = current?.size ?? 0

  useEffect(() => {
    setText(null)
    if (!previewPath) return
    if (previewSize > TEXT_PREVIEW_LIMIT) { setText('This file is too large to preview. Download it instead.'); return }
    const controller = new AbortController()
    fetch(fileUrl(previewPath), { signal: controller.signal })
      .then((response) => {
        // Convert HTTP failures to the same visible preview error state.
        return response.ok ? response.text() : Promise.reject(new Error('Preview unavailable.'))
      })
      // Apply fetched text only if this effect remains active.
      .then(setText)
      .catch((failure) => { if (!controller.signal.aborted) setText(failure instanceof Error ? failure.message : 'Preview unavailable.') })
    return () => controller.abort()
  }, [previewPath, previewSize])

  /** Filter by every whitespace-separated term in the visible path. */
  const visible = useMemo(() => {
    const terms = filter.trim().toLowerCase().split(/\s+/).filter(Boolean)
    return files.filter((file) => terms.every((term) => {
      // Require each query token to occur somewhere in the path.
      return file.path.toLowerCase().includes(term)
    }))
  }, [files, filter])

  const filtering = filter.trim() !== ''
  const tree = useMemo(() => buildTree(visible), [visible])

  /** Toggle one folder's expanded state without mutating the existing set. */
  const toggle = (key: string) => setExpanded((current) => {
    const next = new Set(current)
    if (!next.delete(key)) next.add(key)
    return next
  })

  /** Render folder descendants and file rows for one tree node. */
  function renderNode(parent: TreeNode, depth: number) {
    // Recent goal folders sort newest-first; other folders sort alphabetically.
    const byName = (left: TreeNode, right: TreeNode) => parent.key.startsWith('/goals') ? right.modified.localeCompare(left.modified) : left.name.localeCompare(right.name)
    const folders = [...parent.folders.values()].sort(byName)
    const entries = [...parent.files].sort((left, right) => left.path.localeCompare(right.path))
    return <>
      {folders.map((folder) => {
        const isOpen = filtering || expanded.has(folder.key)
        const label = folder.name
        return <div key={folder.key} role="treeitem" aria-expanded={isOpen} aria-selected={false}>
          <button type="button" className="fb-row fb-folder" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => toggle(folder.key)} title={folder.name}>
            {isOpen ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
            {isOpen ? <FolderOpen size={14} aria-hidden="true" /> : <Folder size={14} aria-hidden="true" />}
            <span className="fb-name">{label}</span><span className="fb-meta">{folder.count}</span>
          </button>
          {isOpen && <div role="group">{renderNode(folder, depth + 1)}</div>}
        </div>
      })}
      {entries.map((file) => (
        <button type="button" role="treeitem" aria-selected={file.path === selected} key={file.path} className="fb-row fb-file" style={{ paddingLeft: 8 + depth * 14 + 18 }} aria-pressed={file.path === selected} onClick={() => setSelected(file.path)} title={`${formatSize(file.size)} · ${stamp(file.modified)}`}>
          <FileText size={14} aria-hidden="true" />
          <span className="fb-name">{file.path.split('/').pop()}</span><span className="fb-meta">{formatSize(file.size)}</span>
        </button>
      ))}
    </>
  }

  /** Confirm, delete, and remove a selected work file from local browser state. */
  async function remove(file: WorkFile) {
    if (lock.current || !window.confirm(`Permanently delete "${file.path.split('/').pop()}"? This cannot be undone.`)) return
    lock.current = true
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await filesRequest({ action: 'delete', path: file.path })
      setFiles((list) => list.filter((entry) => entry.path !== file.path))
      setSelected((value) => value === file.path ? null : value)
      setNotice('File deleted.')
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally { lock.current = false; setBusy(false) }
  }

  if (!open) return null
  const content = (
    <section ref={panel} tabIndex={-1} className={`file-browser${inline ? ' file-browser-inline' : ''}`} role={inline ? 'region' : 'dialog'} aria-modal={inline ? undefined : true} aria-label="File browser" onClick={(event) => event.stopPropagation()}>
      <header className="fb-head">
        <FolderOpen size={18} aria-hidden="true" /><h2>Files</h2><span className="fb-count">{files.length}</span>
        <div className="fb-tools">
          <button type="button" aria-label="Refresh files" title="Refresh files" disabled={busy} onClick={() => void refresh()}><RefreshCw size={16} /> Refresh</button>
          <button type="button" aria-label="Close file browser" title="Close file browser" onClick={close}><X size={16} /> Close</button>
        </div>
      </header>
      {error && <p className="fb-error" role="alert">{error}</p>}
      {notice && <p className="fb-notice" role="status">{notice}</p>}
      {truncated && <p className="fb-notice" role="status">Too many files to list; some goal files are not shown.</p>}
      {!canDelete && files.length > 0 && <p className="fb-notice" role="status">Deleting is disabled in this JARVIS session.</p>}
      <div className="fb-body">
        <div className="fb-list" aria-label="Files created by Jarvis and his agents">
          <input className="fb-filter" type="search" placeholder="Filter files" aria-label="Filter files" value={filter} onChange={(event) => setFilter(event.target.value)} />
          {!visible.length && <p className="fb-empty">{busy ? 'Loading files...' : 'No files.'}</p>}
          <div role="tree" aria-label="File tree">{renderNode(tree, 0)}</div>
        </div>
        <div className="fb-detail">
          {!current && <p className="fb-empty">Select a file to preview it.</p>}
          {current && <>
            <div className="fb-detail-head">
              <h3 title={current.path}>{current.path.split('/').pop()}</h3>
              <span className="fb-actions">
                {current.preview && <a className="fb-button" href={fileUrl(current.path)} target="_blank" rel="noopener noreferrer"><Eye size={16} /> Open</a>}
                <a className="fb-button" href={fileUrl(current.path, true)} download><Download size={16} /> Download</a>
                <button type="button" disabled={busy || !canDelete} title={canDelete ? 'Delete file' : 'Deleting is disabled'} onClick={() => void remove(current)}><Trash2 size={16} /> Delete</button>
              </span>
            </div>
            <p className="fb-path">{current.path}</p>
            <div className="fb-preview">
              {current.preview === 'text' && <pre>{text ?? 'Loading...'}</pre>}
              {current.preview === 'image' && <img src={fileUrl(current.path)} alt={current.path} />}
              {current.preview === 'pdf' && <iframe src={fileUrl(current.path)} title={current.path} />}
              {!current.preview && <p className="fb-empty">No preview for this file type. Download it to view.</p>}
            </div>
          </>}
        </div>
      </div>
    </section>
  )
  // Inline theme docking owns its container; modal mode adds a closing scrim.
  return inline ? content : <div className="command-scrim" onClick={close}>{content}</div>
}
