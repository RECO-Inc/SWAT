import { type FormEvent, useMemo, useState } from 'react'
import './App.css'
import LoadTestPanel from './load/LoadTestPanel'
import FileUpload from './components/FileUpload'
import AnalysisView from './analysis/AnalysisView'
import OcrStatusView from './ocr/OcrStatusView'
import type { RunRecord } from './load/loadTypes'

const MAX_UPLOAD_BYTES = 100 * 1024

type RequestState = {
  status: 'idle' | 'loading' | 'success' | 'error'
  message: string
  data?: unknown
}

type View = 'console' | 'ocr' | 'analysis'

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
  const [uploadMode, setUploadMode] = useState<'async' | 'sync' | 'none'>('async')
  const [ocr, setOcr] = useState<RequestState>({ status: 'idle', message: '' })
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
      setUpload({ status: 'error', message: '이미지 파일을 먼저 선택하세요.' })
      return
    }

    const isSync = uploadMode === 'sync'
    setUpload({
      status: 'loading',
      message: isSync ? 'OCR까지 처리하는 중...' : '이미지 업로드 중...',
    })
    setOcr({ status: 'idle', message: '' })

    const formData = new FormData()
    formData.append('file', file)

    const endpoint =
      uploadMode === 'sync'
        ? '/api/weighing-slip/upload-sync'
        : uploadMode === 'none'
          ? '/api/weighing-slip/upload-only'
          : '/api/weighing-slip/upload'

    try {
      const response = await fetch(`${normalizedApiBaseUrl}${endpoint}`, {
        method: 'POST',
        headers: {
          'X-Test-Run-Id': testRunId,
          'X-Test-Client-Type': 'web',
          'X-Test-Device-Id': deviceId,
          'X-Test-Worker-Id': 'worker-001',
          'X-Test-Request-Seq': '000001',
        },
        body: formData,
      })
      const data = await response.json()

      if (!response.ok) {
        throw new Error(getErrorMessage(data, `업로드 실패 (${response.status})`))
      }

      if (isSync) {
        const latency =
          typeof data === 'object' && data && 'latencyMs' in data
            ? `, ${Math.round(Number((data as { latencyMs: number }).latencyMs))}ms`
            : ''
        setUpload({
          status: 'success',
          message: `동기 OCR 완료 (${response.status}${latency}).`,
          data,
        })
      } else if (uploadMode === 'none') {
        setUpload({
          status: 'success',
          message: `업로드 접수됨 (${response.status}). OCR 미연동 모드입니다.`,
          data,
        })
      } else {
        setUpload({
          status: 'success',
          message: `업로드 접수됨 (${response.status}). OCR은 백그라운드에서 처리됩니다.`,
          data,
        })
        const uploadId =
          typeof data === 'object' && data && 'uploadId' in data
            ? String((data as { uploadId: string }).uploadId)
            : ''
        if (uploadId) {
          void pollOcrResult(uploadId)
        }
      }
    } catch (error) {
      setUpload({
        status: 'error',
        message: error instanceof Error ? error.message : '업로드 실패.',
      })
    }
  }

  async function pollOcrResult(uploadId: string) {
    setOcr({ status: 'loading', message: 'OCR 결과 대기 중...' })
    const deadline = Date.now() + 30000

    while (Date.now() < deadline) {
      try {
        const response = await fetch(
          `${normalizedApiBaseUrl}/api/weighing-slip/ocr-result/${uploadId}`,
        )
        if (response.ok) {
          const data = (await response.json()) as {
            status: string
            error?: string
            latencyMs?: number
          }
          if (data.status === 'done') {
            const latency = data.latencyMs ? `, ${Math.round(data.latencyMs)}ms` : ''
            setOcr({
              status: 'success',
              message: `비동기 OCR 완료 (${data.status}${latency}).`,
              data,
            })
            return
          }
          if (data.status === 'error') {
            setOcr({ status: 'error', message: data.error || 'OCR 처리 실패.', data })
            return
          }
          if (data.status === 'dropped') {
            setOcr({ status: 'error', message: 'OCR 큐 포화로 작업이 드롭되었습니다.', data })
            return
          }
          if (data.status === 'disabled') {
            setOcr({ status: 'error', message: 'OCR 서비스가 비활성화 상태입니다.', data })
            return
          }
        }
      } catch {
        // keep polling until the deadline
      }
      await new Promise((resolve) => setTimeout(resolve, 700))
    }

    setOcr({ status: 'error', message: 'OCR 결과 조회 시간 초과.' })
  }

  const pageTitle =
    view === 'console' ? '부하 테스트' : view === 'ocr' ? 'OCR 현황' : '결과 분석'

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            SW
          </span>
          <span className="brand-text">
            <strong>SWAT</strong>
            <small>Test Console</small>
          </span>
        </div>

        <nav className="nav" aria-label="주요 메뉴">
          <button
            type="button"
            className={`nav-item${view === 'console' ? ' active' : ''}`}
            aria-current={view === 'console' ? 'page' : undefined}
            onClick={() => setView('console')}
          >
            <NavIcon name="bolt" />
            <span>부하 테스트</span>
          </button>
          <button
            type="button"
            className={`nav-item${view === 'ocr' ? ' active' : ''}`}
            aria-current={view === 'ocr' ? 'page' : undefined}
            onClick={() => setView('ocr')}
          >
            <NavIcon name="pulse" />
            <span>OCR 현황</span>
          </button>
          <button
            type="button"
            className={`nav-item${view === 'analysis' ? ' active' : ''}`}
            aria-current={view === 'analysis' ? 'page' : undefined}
            onClick={() => setView('analysis')}
          >
            <NavIcon name="chart" />
            <span>결과 분석</span>
            {runs.length > 0 ? <span className="nav-count">{runs.length}</span> : null}
          </button>
        </nav>

        <div className="sidebar-foot">계근 API 성능 인증 테스트베드</div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="crumb">
            <span className="crumb-root">SWAT</span>
            <span className="crumb-sep" aria-hidden="true">
              /
            </span>
            <span className="crumb-current">{pageTitle}</span>
          </div>
          <div className="topbar-right">
            <span className={`status-pill ${health.status}`}>
              <span className="status-dot" aria-hidden="true" />
              API {HEALTH_LABELS[health.status]}
            </span>
            <span className="badge-info">목표 100 TPS+</span>
          </div>
        </header>

        <main className="content">
          <div className="view" hidden={view !== 'console'}>
            <div className="page-head">
              <h1>계근 API 테스트 콘솔</h1>
              <p className="page-desc">
                HAProxy 뒤의 Go API 상태를 확인하고 계근증 이미지를 업로드해 인증
                테스트 흐름을 빠르게 점검합니다.
              </p>
            </div>

            <section className="panel">
              <div className="panel-heading">
                <div>
                  <p className="section-kicker">Connection</p>
                  <h2>API 연결</h2>
                </div>
                <button
                  type="button"
                  className="button secondary"
                  onClick={checkHealth}
                  disabled={health.status === 'loading'}
                >
                  상태 확인
                </button>
              </div>

              <label className="field">
                <span>API Base URL</span>
                <input
                  value={apiBaseUrl}
                  onChange={(event) => setApiBaseUrl(event.target.value)}
                  placeholder="http://localhost:8080"
                />
                <span className="hint">
                  비워 두면 동일 출처(/api)로 호출합니다.
                </span>
              </label>

              <StatusCard state={health} />
            </section>

            <section className="panel">
              <div className="panel-heading">
                <div>
                  <p className="section-kicker">Upload</p>
                  <h2>계근증 이미지 업로드</h2>
                </div>
                <span className="file-chip">
                  {file ? formatBytes(file.size) : '파일 없음'}
                </span>
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
                  <label className="field">
                    <span>OCR 처리 방식</span>
                    <select
                      value={uploadMode}
                      onChange={(event) =>
                        setUploadMode(event.target.value as 'async' | 'sync' | 'none')
                      }
                    >
                      <option value="async">비동기 (즉시 응답 후 OCR)</option>
                      <option value="sync">동기 (OCR 완료 후 응답)</option>
                      <option value="none">업로드만 (OCR 미연동)</option>
                    </select>
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

                <div className="action-row">
                  <button
                    type="submit"
                    className="button primary"
                    disabled={upload.status === 'loading'}
                  >
                    {uploadMode === 'sync' ? '업로드 + OCR' : '이미지 업로드'}
                  </button>
                </div>
              </form>

              <StatusCard state={upload} />
              {uploadMode === 'async' && ocr.status !== 'idle' ? (
                <StatusCard state={ocr} />
              ) : null}
            </section>

            <LoadTestPanel
              apiBaseUrl={normalizedApiBaseUrl}
              testRunId={testRunId}
              deviceId={deviceId}
              onRunComplete={addRun}
            />
          </div>

          <div className="view" hidden={view !== 'ocr'}>
            <div className="page-head">
              <h1>OCR 현황</h1>
              <p className="page-desc">
                비동기로 접수된 업로드의 OCR 큐 적재·처리중·완료·실패·드롭 상태를
                실시간으로 확인합니다.
              </p>
            </div>
            <OcrStatusView apiBaseUrl={normalizedApiBaseUrl} />
          </div>

          <div className="view" hidden={view !== 'analysis'}>
            <div className="page-head">
              <h1>결과 분석</h1>
              <p className="page-desc">
                실행한 부하 테스트의 시계열과 통계를 그래프로 비교 분석합니다.
              </p>
            </div>
            <AnalysisView runs={runs} onClear={() => setRuns([])} />
          </div>
        </main>
      </div>
    </div>
  )
}

const HEALTH_LABELS: Record<RequestState['status'], string> = {
  idle: '미확인',
  loading: '확인 중',
  success: '정상',
  error: '오류',
}

function NavIcon({ name }: { name: 'bolt' | 'chart' | 'pulse' }) {
  if (name === 'bolt') {
    return (
      <svg className="nav-svg" viewBox="0 0 20 20" aria-hidden="true">
        <path
          d="M11 1 3 11h5l-1 8 8-10h-5l1-8Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
      </svg>
    )
  }
  if (name === 'pulse') {
    return (
      <svg className="nav-svg" viewBox="0 0 20 20" aria-hidden="true">
        <path
          d="M2 10h4l2-6 4 12 2-6h4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )
  }
  return (
    <svg className="nav-svg" viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="M3 3v14h14M7 13l3-4 2.5 2.5L17 6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function StatusCard({ state }: { state: RequestState }) {
  if (state.status === 'idle') {
    return null
  }
  return (
    <div className={`status-card ${state.status}`} role="status">
      <span className="status-card-icon" aria-hidden="true">
        {state.status === 'success' ? '✓' : state.status === 'error' ? '!' : '…'}
      </span>
      <div className="status-card-body">
        <strong>{state.message}</strong>
        {state.data ? <pre>{JSON.stringify(state.data, null, 2)}</pre> : null}
      </div>
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
