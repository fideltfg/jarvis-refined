import { formatBytes, type Attachment, type AttachmentMeta } from '../lib/attachments'

const KIND_LABEL = { image: 'IMG', pdf: 'PDF', text: 'TXT' } as const

/** Pending attachments in a composer, each removable. */
export function AttachmentTray({ attachments, onRemove }: { attachments: Attachment[]; onRemove: (index: number) => void }) {
  if (!attachments.length) return null
  return (
    <ul className="attachment-tray" aria-label="Attached files">
      {attachments.map((file, index) => (
        <li className="attachment-chip" key={`${file.name}-${index}`} title={`${file.name} (${formatBytes(file.size)})`}>
          {file.kind === 'image'
            ? <img src={`data:${file.mimeType};base64,${file.data}`} alt="" />
            : <span className="attachment-kind">{KIND_LABEL[file.kind]}</span>}
          <span className="attachment-name">{file.name}</span>
          <button type="button" onClick={() => onRemove(index)} aria-label={`Remove ${file.name}`} title="Remove">×</button>
        </li>
      ))}
    </ul>
  )
}

/** Names of the files sent with a turn, for transcripts. */
export function AttachmentNames({ attachments }: { attachments?: AttachmentMeta[] }) {
  if (!attachments?.length) return null
  return (
    <ul className="attachment-names" aria-label="Attached files">
      {attachments.map((file, index) => (
        <li key={`${file.name}-${index}`} title={formatBytes(file.size)}>
          <span className="attachment-kind">{KIND_LABEL[file.kind]}</span>{file.name}
        </li>
      ))}
    </ul>
  )
}
