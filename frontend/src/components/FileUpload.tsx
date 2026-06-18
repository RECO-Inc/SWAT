import {
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

type Props = {
  label: string
  file: File | null
  onFileChange: (file: File | null) => void
  accept?: string
  hint?: string
  disabled?: boolean
  required?: boolean
  maxBytes?: number
}

function FileUpload({
  label,
  file,
  onFileChange,
  accept = 'image/*',
  hint,
  disabled = false,
  required = false,
  maxBytes,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  const previewUrl = useMemo(() => {
    if (file && file.type.startsWith('image/')) {
      return URL.createObjectURL(file)
    }
    return null
  }, [file])

  useEffect(() => {
    if (!previewUrl) return undefined
    return () => URL.revokeObjectURL(previewUrl)
  }, [previewUrl])

  const tooLarge = maxBytes !== undefined && file !== null && file.size > maxBytes

  function openPicker() {
    if (!disabled) inputRef.current?.click()
  }

  function onInputChange(event: ChangeEvent<HTMLInputElement>) {
    onFileChange(event.target.files?.[0] ?? null)
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setDragging(false)
    if (disabled) return
    const dropped = event.dataTransfer.files?.[0]
    if (dropped) onFileChange(dropped)
  }

  function onDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    if (!disabled) setDragging(true)
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      openPicker()
    }
  }

  function clear() {
    onFileChange(null)
    if (inputRef.current) inputRef.current.value = ''
  }

  return (
    <div className="field">
      <span>
        {label}
        {required ? <em className="field-req" aria-hidden="true"> *</em> : null}
      </span>

      {file ? (
        <div className={`file-item${tooLarge ? ' error' : ''}`}>
          {previewUrl ? (
            <img className="file-thumb" src={previewUrl} alt="" />
          ) : (
            <div className="file-thumb placeholder">FILE</div>
          )}
          <div className="file-meta">
            <strong className="file-name">{file.name}</strong>
            <span className="file-sub">
              {formatBytes(file.size)}
              {file.type ? ` · ${file.type}` : ''}
            </span>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={clear}
            disabled={disabled}
            aria-label="파일 제거"
          >
            ×
          </button>
        </div>
      ) : (
        <div
          className={`dropzone${dragging ? ' dragging' : ''}${disabled ? ' disabled' : ''}`}
          onClick={openPicker}
          onDrop={onDrop}
          onDragOver={onDragOver}
          onDragLeave={() => setDragging(false)}
          onKeyDown={onKeyDown}
          role="button"
          tabIndex={disabled ? -1 : 0}
          aria-disabled={disabled}
        >
          <strong className="dropzone-title">
            파일을 끌어다 놓거나 클릭해서 선택
          </strong>
          {hint ? <span className="dropzone-hint">{hint}</span> : null}
        </div>
      )}

      <input
        ref={inputRef}
        className="visually-hidden"
        type="file"
        accept={accept}
        onChange={onInputChange}
        disabled={disabled}
        tabIndex={-1}
      />

      {tooLarge && maxBytes !== undefined ? (
        <span className="field-error">
          파일이 너무 큽니다. 최대 {formatBytes(maxBytes)}까지 업로드하세요.
        </span>
      ) : null}
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KiB`
}

export default FileUpload
