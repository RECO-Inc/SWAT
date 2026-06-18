import { type FormEvent, useMemo, useState } from 'react'
import './App.css'
import LoadTestPanel from './load/LoadTestPanel'
import FileUpload from './components/FileUpload'
import AnalysisView from './analysis/AnalysisView'
import type { RunRecord } from './load/loadTypes'

const MAX_UPLOAD_BYTES = 100 * 1024

type RequestState = {
  status: 'idle' | 'loading' | 'success' | 'error'
  message: string
  data?: unknown
}

type View = 'console' | 'analysis'

const defaultApiBaseUrl =
  import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8080'

function App() {
  const [apiBaseUrl, setApiBaseUrl] = useState(defaultApiBaseUrl)
  const [testRunId, setTestRunId] = useState('CERT-FRONTEND-SMOKE-001')
  const [deviceId, setDeviceId] = useState('browser-01')
  const [file, setFile] = useState<File | null>(null)
  const [health, setHealth] = useState<RequestState>({
    status: 'idle',
    message: 'Not checked yet.',
  })
  const [upload, setUpload] = useState<RequestState>({
    status: 'idle',
    message: 'No upload yet.',
  })
  const [view, setView] = useState<View>('console')
  const [runs, setRuns] = useState<RunRecord[]>([])

  function addRun(run: RunRecord) {
    setRuns((previous) => [run, ...previous])
  }

  const normalizedApiBaseUrl = useMemo(
    () => apiBaseUrl.replace(/\/+$/, ''),
    [apiBaseUrl],
  )

  async function checkHealth() {
    setHealth({ status: 'loading', message: 'Checking API health...' })

    try {
      const response = await fetch(`${normalizedApiBaseUrl}/health`)
      const data = await response.json()

      if (!response.ok) {
        throw new Error(`Health check failed with ${response.status}`)
      }

      setHealth({
        status: 'success',
        message: `API is healthy (${response.status}).`,
        data,
      })
    } catch (error) {
      setHealth({
        status: 'error',
        message: error instanceof Error ? error.message : 'Health check failed.',
      })
    }
  }

  async function uploadImage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (!file) {
      setUpload({ status: 'error', message: 'Select an image file first.' })
      return
    }

    setUpload({ status: 'loading', message: 'Uploading image...' })

    const formData = new FormData()
    formData.append('file', file)

    try {
      const response = await fetch(
        `${normalizedApiBaseUrl}/api/weighing-slip/upload`,
        {
          method: 'POST',
          headers: {
            'X-Test-Run-Id': testRunId,
            'X-Test-Client-Type': 'web',
            'X-Test-Device-Id': deviceId,
            'X-Test-Worker-Id': 'worker-001',
            'X-Test-Request-Seq': '000001',
          },
          body: formData,
        },
      )
      const data = await response.json()

      if (!response.ok) {
        throw new Error(getErrorMessage(data, `Upload failed with ${response.status}`))
      }

      setUpload({
        status: 'success',
        message: `Upload accepted (${response.status}).`,
        data,
      })
    } catch (error) {
      setUpload({
        status: 'error',
        message: error instanceof Error ? error.message : 'Upload failed.',
      })
    }
  }

  return (
    <main className="app-shell">
      <section className="hero">
        <div className="hero-text">
          <p className="eyebrow">SWAT Web Test Console</p>
          <h1>계근 API 테스트 콘솔</h1>
          <p className="hero-copy">
            HAProxy 뒤의 Go API 상태를 확인하고 계근증 이미지를 업로드해
            인증 테스트 흐름을 빠르게 점검합니다.
          </p>
        </div>
        <div className="hero-summary" aria-label="Certification target">
          <span>Target</span>
          <strong>100 TPS+</strong>
          <small>100KB image upload smoke path</small>
        </div>
      </section>

      <div className="view-switch" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={view === 'console'}
          className={`view-tab${view === 'console' ? ' active' : ''}`}
          onClick={() => setView('console')}
        >
          부하 테스트
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'analysis'}
          className={`view-tab${view === 'analysis' ? ' active' : ''}`}
          onClick={() => setView('analysis')}
        >
          결과 분석 ({runs.length})
        </button>
      </div>

      <div className="view" hidden={view !== 'console'}>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <p className="section-kicker">Connection</p>
            <h2>API 연결</h2>
          </div>
          <button type="button" className="button primary" onClick={checkHealth} disabled={health.status === 'loading'}>
            Check health
          </button>
        </div>

        <label className="field">
          <span>API Base URL</span>
          <input
            value={apiBaseUrl}
            onChange={(event) => setApiBaseUrl(event.target.value)}
            placeholder="http://localhost:8080"
          />
        </label>

        <StatusCard state={health} />
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <p className="section-kicker">Upload</p>
            <h2>계근증 이미지 업로드</h2>
          </div>
          <span className="file-chip">{file ? formatBytes(file.size) : 'No file selected'}</span>
        </div>

        <form onSubmit={uploadImage} className="upload-form">
          <div className="form-grid">
            <label className="field">
              <span>Test Run ID</span>
              <input
                value={testRunId}
                onChange={(event) => setTestRunId(event.target.value)}
              />
            </label>
            <label className="field">
              <span>Device ID</span>
              <input
                value={deviceId}
                onChange={(event) => setDeviceId(event.target.value)}
              />
            </label>
          </div>

          <FileUpload
            label="계근증 이미지"
            file={file}
            onFileChange={setFile}
            accept="image/*"
            hint="JPG/PNG · 최대 100KB 권장 (인증 기준)"
            maxBytes={MAX_UPLOAD_BYTES}
            required
          />

          <button type="submit" className="button primary" disabled={upload.status === 'loading'}>
            Upload image
          </button>
        </form>

        <StatusCard state={upload} />
      </section>

      <LoadTestPanel
        apiBaseUrl={normalizedApiBaseUrl}
        testRunId={testRunId}
        deviceId={deviceId}
        onRunComplete={addRun}
      />
      </div>

      <div className="view" hidden={view !== 'analysis'}>
        <AnalysisView runs={runs} onClear={() => setRuns([])} />
      </div>
    </main>
  )
}

function StatusCard({ state }: { state: RequestState }) {
  return (
    <div className={`status-card ${state.status}`}>
      <strong>{state.message}</strong>
      {state.data ? <pre>{JSON.stringify(state.data, null, 2)}</pre> : null}
    </div>
  )
}

function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`
  }

  return `${(bytes / 1024).toFixed(1)} KiB`
}

function getErrorMessage(data: unknown, fallback: string) {
  if (
    typeof data === 'object' &&
    data !== null &&
    'error' in data &&
    typeof data.error === 'string'
  ) {
    return data.error
  }

  return fallback
}

export default App
