import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  LoadConfig,
  LoadEvidence,
  LoadSample,
  LoadSnapshot,
  LoadTestType,
  RunRecord,
  WorkerOutbound,
} from './loadTypes'
import { emptySnapshot, isImageTestType } from './loadTypes'
import FileUpload from '../components/FileUpload'
import { WEIGHING_PROFILE_NAME } from '../weighing/weighingGenerator'

type Props = {
  apiBaseUrl: string
  testRunId: string
  deviceId: string
  onRunComplete: (run: RunRecord) => void
}

const TEST_TYPE_LABELS: Record<LoadTestType, string> = {
  'image-upload': '이미지 업로드 (비동기 OCR)',
  'image-upload-sync': '이미지 업로드 (동기 OCR)',
  'image-upload-only': '이미지 업로드 (OCR 미연동)',
  'weighing-data': '계근 데이터 단건',
  'weighing-data-bulk': '계근 데이터 벌크',
}

type RateMode = 'fixed' | 'max'

function LoadTestPanel({ apiBaseUrl, testRunId, deviceId, onRunComplete }: Props) {
  const [testType, setTestType] = useState<LoadTestType>('image-upload')
  const [authToken, setAuthToken] = useState('')
  const [rateMode, setRateMode] = useState<RateMode>('fixed')
  const [workerCount, setWorkerCount] = useState(100)
  const [workerTps, setWorkerTps] = useState(1)
  const [durationSec, setDurationSec] = useState(60)
  const [rampUpSec, setRampUpSec] = useState(5)
  const [syntheticKb, setSyntheticKb] = useState(100)
  const [loadFile, setLoadFile] = useState<File | null>(null)
  const [bulkSize, setBulkSize] = useState(10)
  const [evidenceLimit, setEvidenceLimit] = useState(0)

  const [snapshot, setSnapshot] = useState<LoadSnapshot>(emptySnapshot())
  const [loadEvidence, setLoadEvidence] = useState<LoadEvidence | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [submitState, setSubmitState] = useState('')

  const workerRef = useRef<Worker | null>(null)
  const samplesRef = useRef<LoadSample[]>([])

  useEffect(() => {
    return () => {
      workerRef.current?.terminate()
      workerRef.current = null
    }
  }, [])

  const effectiveWorkerTps = rateMode === 'max' ? 0 : Math.max(1, workerTps)

  const targetTps = useMemo(() => {
    if (effectiveWorkerTps <= 0) return '최대치(closed loop)'
    return `${workerCount * effectiveWorkerTps} TPS`
  }, [workerCount, effectiveWorkerTps])

  const isImage = isImageTestType(testType)
  const isBulk = testType === 'weighing-data-bulk'
  const isWeighing = !isImage
  const hasEvidence = Boolean(loadEvidence && loadEvidence.items.length > 0)
  const averageTps = snapshot.elapsedSec > 0 ? snapshot.sent / snapshot.elapsedSec : 0

  async function buildImageBytes(): Promise<{
    bytes: ArrayBuffer
    name: string
    contentType: string
  }> {
    if (loadFile) {
      return {
        bytes: await loadFile.arrayBuffer(),
        name: loadFile.name,
        contentType: loadFile.type || 'image/jpeg',
      }
    }

    const size = Math.max(1, syntheticKb) * 1024
    const bytes = new Uint8Array(size)
    crypto.getRandomValues(bytes.subarray(0, Math.min(size, 65536)))
    return {
      bytes: bytes.buffer,
      name: `synthetic-${syntheticKb}kb.jpg`,
      contentType: 'image/jpeg',
    }
  }

  async function start() {
    setError('')
    setSubmitState('')
    setLoadEvidence(null)

    const config: LoadConfig = {
      apiBaseUrl,
      testType,
      testRunId,
      deviceId,
      authToken,
      workerCount: Math.max(1, workerCount),
      workerTps: effectiveWorkerTps,
      durationSec: Math.max(0, durationSec),
      rampUpSec: Math.max(0, rampUpSec),
      bulkSize: Math.max(1, bulkSize),
      evidenceLimit: Math.max(0, evidenceLimit),
    }

    const transfer: Transferable[] = []
    if (isImage) {
      try {
        const image = await buildImageBytes()
        config.imageBytes = image.bytes
        config.imageName = image.name
        config.imageContentType = image.contentType
        transfer.push(image.bytes)
      } catch {
        setError('이미지 데이터를 읽지 못했습니다.')
        return
      }
    }

    const meta = {
      testType: config.testType,
      testRunId: config.testRunId,
      workerCount: config.workerCount,
      workerTps: config.workerTps,
      durationSec: config.durationSec,
      startedAt: new Date().toISOString(),
    }
    samplesRef.current = []

    workerRef.current?.terminate()
    const worker = new Worker(new URL('./loadWorker.ts', import.meta.url), {
      type: 'module',
    })
    worker.onmessage = (event: MessageEvent<WorkerOutbound>) => {
      const message = event.data
      if (message.type === 'progress') {
        setSnapshot(message.snapshot)
        samplesRef.current.push(toSample(message.snapshot))
      } else if (message.type === 'done') {
        setSnapshot(message.snapshot)
        setLoadEvidence(message.evidence ?? null)
        samplesRef.current.push(toSample(message.snapshot))
        setRunning(false)
        onRunComplete({
          id:
            typeof crypto !== 'undefined' && 'randomUUID' in crypto
              ? crypto.randomUUID()
              : `run-${Date.now()}`,
          startedAt: meta.startedAt,
          testType: meta.testType,
          testRunId: meta.testRunId,
          workerCount: meta.workerCount,
          workerTps: meta.workerTps,
          durationSec: meta.durationSec,
          samples: samplesRef.current.slice(),
          final: message.snapshot,
        })
      } else if (message.type === 'error') {
        setError(message.message)
        setRunning(false)
      }
    }
    workerRef.current = worker

    setSnapshot(emptySnapshot(config.durationSec))
    setRunning(true)
    worker.postMessage({ type: 'start', config }, transfer)
  }

  function stop() {
    workerRef.current?.postMessage({ type: 'stop' })
  }

  function buildResultPayload() {
    return {
      testRunId,
      testType,
      targetTps: effectiveWorkerTps > 0 ? workerCount * effectiveWorkerTps : 0,
      workerCount,
      workerTps: effectiveWorkerTps,
      durationSec,
      sentCount: snapshot.sent,
      successCount: snapshot.success,
      failCount: snapshot.fail,
      averageLatencyMs: round(snapshot.avgLatencyMs),
      p95LatencyMs: round(snapshot.p95LatencyMs),
      p99LatencyMs: round(snapshot.p99LatencyMs),
    }
  }

  function exportJson() {
    const payload = {
      config: {
        apiBaseUrl,
        testType,
        testRunId,
        deviceId,
        workerCount,
        workerTps: effectiveWorkerTps,
        rateMode,
        durationSec,
        rampUpSec,
        bulkSize: isBulk ? bulkSize : undefined,
        weighingProfile: isWeighing ? WEIGHING_PROFILE_NAME : undefined,
        evidenceLimit: isWeighing ? evidenceLimit : undefined,
      },
      result: snapshot,
      evidence: loadEvidence
        ? {
            capturedCount: loadEvidence.capturedCount,
            droppedCount: loadEvidence.droppedCount,
          }
        : undefined,
      exportedAt: new Date().toISOString(),
    }
    downloadFile(
      `swat-loadtest-${testRunId}.json`,
      JSON.stringify(payload, null, 2),
      'application/json',
    )
  }

  function exportCsv() {
    const rows: Array<[string, string | number]> = [
      ['testRunId', testRunId],
      ['testType', testType],
      ['rateMode', rateMode],
      ['workerCount', workerCount],
      ['workerTps', effectiveWorkerTps],
      ['durationSec', durationSec],
      ['elapsedSec', round(snapshot.elapsedSec)],
      ['sent', snapshot.sent],
      ['success', snapshot.success],
      ['fail', snapshot.fail],
      ['currentTps', round(snapshot.currentTps)],
      ['averageTps', round(averageTps)],
      ['avgLatencyMs', round(snapshot.avgLatencyMs)],
      ['p95LatencyMs', round(snapshot.p95LatencyMs)],
      ['p99LatencyMs', round(snapshot.p99LatencyMs)],
      ['maxLatencyMs', round(snapshot.maxLatencyMs)],
      ['evidenceCaptured', snapshot.evidenceCaptured],
      ['evidenceDropped', snapshot.evidenceDropped],
    ]
    for (const [code, count] of Object.entries(snapshot.statusCounts)) {
      rows.push([`status_${code}`, count])
    }
    const csv = ['metric,value', ...rows.map(([k, v]) => `${k},${v}`)].join('\n')
    downloadFile(`swat-loadtest-${testRunId}.csv`, csv, 'text/csv')
  }

  async function copySummary() {
    const summary = buildSummaryText()
    try {
      await navigator.clipboard.writeText(summary)
      setSubmitState('인증 요약을 클립보드에 복사했습니다.')
    } catch {
      setSubmitState('클립보드 복사에 실패했습니다.')
    }
  }

  function buildSummaryText() {
    const successRate =
      snapshot.sent > 0
        ? ((snapshot.success / snapshot.sent) * 100).toFixed(2)
        : '0.00'
    return [
      `Test Run: ${testRunId}`,
      `Type: ${TEST_TYPE_LABELS[testType]}`,
      `Model: ${workerCount} workers x ${effectiveWorkerTps} TPS (target ${targetTps})`,
      `Duration: ${round(snapshot.elapsedSec)}s / ${durationSec}s`,
      `Sent ${snapshot.sent} / Success ${snapshot.success} / Fail ${snapshot.fail} (${successRate}%)`,
      `TPS now: ${round(snapshot.currentTps)} / avg ${round(averageTps)}`,
      `Latency avg ${round(snapshot.avgLatencyMs)}ms / p95 ${round(snapshot.p95LatencyMs)}ms / p99 ${round(snapshot.p99LatencyMs)}ms`,
      `Status: ${Object.entries(snapshot.statusCounts)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ')}`,
    ].join('\n')
  }

  async function submitResult() {
    setSubmitState('결과 전송 중...')
    try {
      const response = await fetch(`${apiBaseUrl}/api/test-result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildResultPayload()),
      })
      if (!response.ok) {
        throw new Error(`전송 실패 (${response.status})`)
      }
      setSubmitState('결과를 API로 전송했습니다.')
    } catch (submitError) {
      setSubmitState(
        submitError instanceof Error ? submitError.message : '결과 전송 실패',
      )
    }
  }

  function handleTestTypeChange(next: LoadTestType) {
    setTestType(next)
    if (!isImageTestType(next)) {
      setRateMode('max')
      setWorkerTps(0)
    }
  }

  function handleRateModeChange(next: RateMode) {
    setRateMode(next)
    if (next === 'max') {
      setWorkerTps(0)
    } else if (workerTps <= 0) {
      setWorkerTps(1)
    }
  }

  function exportEvidenceRequests() {
    if (!loadEvidence) return
    const sentItems = flattenEvidenceRequestRows(loadEvidence)
    const payload = {
      generatedAt: new Date().toISOString(),
      profile: WEIGHING_PROFILE_NAME,
      count: sentItems.length,
      items: sentItems,
    }
    downloadFile(
      `swat-weighing-requests-${testRunId}.json`,
      JSON.stringify(payload, null, 2),
      'application/json',
    )
  }

  function exportEvidenceResponses() {
    if (!loadEvidence) return
    const payload = {
      testRunId,
      testType,
      exportedAt: new Date().toISOString(),
      capturedCount: loadEvidence.capturedCount,
      droppedCount: loadEvidence.droppedCount,
      responses: loadEvidence.items.map((item) => ({
        index: item.index,
        workerId: item.workerId,
        requestSeq: item.requestSeq,
        status: item.status,
        ok: item.ok,
        latencyMs: item.latencyMs,
        completedAt: item.completedAt,
        body: item.responseBody,
        error: item.error,
      })),
    }
    downloadFile(
      `swat-weighing-responses-${testRunId}.json`,
      JSON.stringify(payload, null, 2),
      'application/json',
    )
  }

  function exportEvidenceComparison() {
    if (!loadEvidence) return
    downloadFile(
      `swat-weighing-comparison-${testRunId}.json`,
      JSON.stringify(buildEvidenceComparison(loadEvidence, testRunId, testType), null, 2),
      'application/json',
    )
  }

  const hasResult = snapshot.sent > 0
  const successRate =
    snapshot.sent > 0 ? (snapshot.success / snapshot.sent) * 100 : 0
  const progressPct =
    snapshot.durationSec > 0
      ? Math.min(100, (snapshot.elapsedSec / snapshot.durationSec) * 100)
      : running
        ? 100
        : 0

  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <p className="section-kicker">Load Test</p>
          <h2>부하 생성 테스트</h2>
        </div>
        <span className="file-chip">target {targetTps}</span>
      </div>

      <div className="form-grid">
        <label className="field">
          <span>테스트 종류</span>
          <select
            value={testType}
            onChange={(event) => handleTestTypeChange(event.target.value as LoadTestType)}
            disabled={running}
          >
            <option value="image-upload">이미지 업로드 (비동기 OCR)</option>
            <option value="image-upload-sync">이미지 업로드 (동기 OCR)</option>
            <option value="image-upload-only">이미지 업로드 (OCR 미연동)</option>
            <option value="weighing-data">계근 데이터 단건</option>
            <option value="weighing-data-bulk">계근 데이터 벌크</option>
          </select>
        </label>
        <label className="field">
          <span>Authorization (선택)</span>
          <input
            value={authToken}
            onChange={(event) => setAuthToken(event.target.value)}
            placeholder="Bearer ..."
            disabled={running}
          />
        </label>
      </div>

      <div className="form-grid load-grid">
        <label className="field">
          <span>부하 방식</span>
          <select
            value={rateMode}
            onChange={(event) => handleRateModeChange(event.target.value as RateMode)}
            disabled={running}
          >
            <option value="max">최대 처리량</option>
            <option value="fixed">워커당 TPS 제한</option>
          </select>
        </label>
        <label className="field">
          <span>워커 수</span>
          <input
            type="number"
            min={1}
            value={workerCount}
            onChange={(event) => setWorkerCount(toInt(event.target.value))}
            disabled={running}
          />
        </label>
        <label className="field">
          <span>워커당 TPS</span>
          <input
            type="number"
            min={1}
            value={workerTps}
            onChange={(event) => setWorkerTps(toInt(event.target.value))}
            disabled={running || rateMode === 'max'}
          />
        </label>
        <label className="field">
          <span>지속 시간(초)</span>
          <input
            type="number"
            min={0}
            value={durationSec}
            onChange={(event) => setDurationSec(toInt(event.target.value))}
            disabled={running}
          />
        </label>
        <label className="field">
          <span>램프업(초)</span>
          <input
            type="number"
            min={0}
            value={rampUpSec}
            onChange={(event) => setRampUpSec(toInt(event.target.value))}
            disabled={running}
          />
        </label>
      </div>

      {isImage ? (
        <>
          <FileUpload
            label="부하 테스트 이미지 (계근증 업로드와 별도)"
            file={loadFile}
            onFileChange={setLoadFile}
            accept="image/*"
            hint="파일 미선택 시 아래 크기로 합성 페이로드를 생성합니다."
            disabled={running}
          />
          <label className="field">
            <span>합성 이미지 크기(KB)</span>
            <input
              type="number"
              min={1}
              value={syntheticKb}
              onChange={(event) => setSyntheticKb(toInt(event.target.value))}
              disabled={running || loadFile !== null}
            />
          </label>
        </>
      ) : (
        <>
          <div className="form-grid">
            <label className="field">
              <span>데이터 생성 방식</span>
              <input value={`가상 계근 데이터 (${WEIGHING_PROFILE_NAME})`} disabled readOnly />
            </label>
            <label className="field">
              <span>비교 캡처 최대 건수</span>
              <input
                type="number"
                min={0}
                value={evidenceLimit}
                onChange={(event) => setEvidenceLimit(toInt(event.target.value))}
                disabled={running}
              />
              <span className="hint">0은 전체 캡처입니다.</span>
            </label>
          </div>
          {isBulk ? (
            <label className="field">
              <span>벌크 크기 (요청당 행 수)</span>
              <input
                type="number"
                min={1}
                value={bulkSize}
                onChange={(event) => setBulkSize(toInt(event.target.value))}
                disabled={running}
              />
            </label>
          ) : null}
        </>
      )}

      <div className="action-row">
        {running ? (
          <button type="button" className="button danger" onClick={stop}>
            중지
          </button>
        ) : (
          <button type="button" className="button primary" onClick={start}>
            테스트 시작
          </button>
        )}
        <span className="run-state">
          {running ? '실행 중' : hasResult ? '완료' : '대기'}
        </span>
      </div>

      <div className="progress-track" aria-hidden="true">
        <div className="progress-fill" style={{ width: `${progressPct}%` }} />
      </div>

      {error ? (
        <div className="status-card error" role="status">
          <span className="status-card-icon" aria-hidden="true">
            !
          </span>
          <div className="status-card-body">
            <strong>{error}</strong>
          </div>
        </div>
      ) : null}

      <div className="metric-grid">
        <Metric label="전송" value={snapshot.sent} />
        <Metric label="성공" value={snapshot.success} tone="success" />
        <Metric label="실패" value={snapshot.fail} tone={snapshot.fail > 0 ? 'error' : undefined} />
        <Metric label="현재 TPS" value={round(snapshot.currentTps)} />
        <Metric label="평균 TPS" value={round(averageTps)} />
        <Metric label="성공률" value={`${successRate.toFixed(1)}%`} />
        <Metric label="진행" value={`${round(snapshot.elapsedSec)}s`} />
        <Metric label="평균(ms)" value={round(snapshot.avgLatencyMs)} />
        <Metric label="p95(ms)" value={round(snapshot.p95LatencyMs)} />
        <Metric label="p99(ms)" value={round(snapshot.p99LatencyMs)} />
        <Metric label="최대(ms)" value={round(snapshot.maxLatencyMs)} />
        <Metric label="인플라이트" value={snapshot.inFlight} />
        <Metric label="캡처" value={`${snapshot.evidenceCaptured}/${snapshot.evidenceDropped}`} />
        <Metric
          label="상태코드"
          value={
            Object.keys(snapshot.statusCounts).length > 0
              ? Object.entries(snapshot.statusCounts)
                  .map(([k, v]) => `${k}:${v}`)
                  .join(' ')
              : '-'
          }
        />
      </div>

      {snapshot.errors.length > 0 ? (
        <div className="status-card error">
          <span className="status-card-icon" aria-hidden="true">
            !
          </span>
          <div className="status-card-body">
            <strong>오류 ({snapshot.errors.length})</strong>
            <pre>{snapshot.errors.join('\n')}</pre>
          </div>
        </div>
      ) : null}

      <div className="action-row wrap">
        <button type="button" className="button secondary" onClick={exportCsv} disabled={!hasResult}>
          CSV 내보내기
        </button>
        <button type="button" className="button secondary" onClick={exportJson} disabled={!hasResult}>
          JSON 내보내기
        </button>
        <button type="button" className="button secondary" onClick={copySummary} disabled={!hasResult}>
          요약 복사
        </button>
        <button type="button" className="button secondary" onClick={submitResult} disabled={!hasResult || running}>
          결과 API 전송
        </button>
        {isWeighing ? (
          <>
            <button
              type="button"
              className="button secondary"
              onClick={exportEvidenceRequests}
              disabled={!hasEvidence || running}
            >
              전송 데이터 다운로드
            </button>
            <button
              type="button"
              className="button secondary"
              onClick={exportEvidenceResponses}
              disabled={!hasEvidence || running}
            >
              응답 JSON 다운로드
            </button>
            <button
              type="button"
              className="button secondary"
              onClick={exportEvidenceComparison}
              disabled={!hasEvidence || running}
            >
              요청/응답 비교
            </button>
          </>
        ) : null}
      </div>

      {submitState ? <p className="hint">{submitState}</p> : null}
    </section>
  )
}

function buildEvidenceComparison(
  evidence: LoadEvidence,
  testRunId: string,
  testType: LoadTestType,
) {
  const rows = evidence.items.flatMap((item) => {
    const sentRows = extractRequestRows(item.requestBody)
    const responseRows = extractResponseRows(item.responseBody)
    return sentRows.map((sent, rowIndex) => {
      const response = responseRows[rowIndex] ?? null
      const matched = response ? rowMatches(sent, response.request, response.item) : false
      return {
        evidenceIndex: item.index,
        workerId: item.workerId,
        requestSeq: item.requestSeq,
        rowIndex,
        status: item.status,
        ok: item.ok,
        latencyMs: item.latencyMs,
        matched,
        sent,
        responseRequest: response?.request ?? null,
        stored: response?.item ?? null,
        error: item.error,
      }
    })
  })

  const matchedCount = rows.filter((row) => row.matched).length

  return {
    testRunId,
    testType,
    generatedAt: new Date().toISOString(),
    capturedRequests: evidence.capturedCount,
    droppedRequests: evidence.droppedCount,
    comparedRows: rows.length,
    matchedRows: matchedCount,
    mismatchedRows: rows.length - matchedCount,
    rows,
  }
}

function flattenEvidenceRequestRows(evidence: LoadEvidence): unknown[] {
  return evidence.items.flatMap((item) => extractRequestRows(item.requestBody))
}

function extractRequestRows(body: unknown): unknown[] {
  if (isRecord(body) && Array.isArray(body.items)) {
    return body.items
  }
  return typeof body === 'undefined' ? [] : [body]
}

function extractResponseRows(body: unknown): Array<{ request: unknown; item: unknown }> {
  if (!isRecord(body)) return []

  if (Array.isArray(body.items)) {
    const requests = Array.isArray(body.requests) ? body.requests : []
    return body.items.map((item, index) => ({
      request: requests[index] ?? null,
      item,
    }))
  }

  if ('item' in body) {
    return [{ request: body.request ?? null, item: body.item }]
  }

  return []
}

function rowMatches(sent: unknown, responseRequest: unknown, stored: unknown): boolean {
  const echoed = isRecord(responseRequest) ? responseRequest : null
  const storedRow = isRecord(stored) ? stored : null
  if (!storedRow) return false

  return (
    fieldEquals(sent, echoed, storedRow, 'ticketId') &&
    fieldEquals(sent, echoed, storedRow, 'vehicleNo') &&
    fieldEquals(sent, echoed, storedRow, 'grossWeightKg') &&
    fieldEquals(sent, echoed, storedRow, 'tareWeightKg')
  )
}

function fieldEquals(
  sent: unknown,
  echoed: Record<string, unknown> | null,
  stored: Record<string, unknown>,
  field: string,
): boolean {
  const sentValue = isRecord(sent) ? sent[field] : undefined
  const expected = echoed?.[field] ?? sentValue
  return normalizeComparable(expected) === normalizeComparable(stored[field])
}

function normalizeComparable(value: unknown): string {
  return typeof value === 'number' ? String(value) : String(value ?? '')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string
  value: string | number
  tone?: 'success' | 'error'
}) {
  return (
    <div className={`metric${tone ? ` ${tone}` : ''}`}>
      <span className="metric-label">{label}</span>
      <strong className="metric-value">{value}</strong>
    </div>
  )
}

function toSample(snapshot: LoadSnapshot): LoadSample {
  return {
    t: Math.round(snapshot.elapsedSec * 10) / 10,
    currentTps: snapshot.currentTps,
    avgLatencyMs: snapshot.avgLatencyMs,
    p95LatencyMs: snapshot.p95LatencyMs,
    p99LatencyMs: snapshot.p99LatencyMs,
    sent: snapshot.sent,
    success: snapshot.success,
    fail: snapshot.fail,
    inFlight: snapshot.inFlight,
  }
}

function toInt(value: string): number {
  const parsed = Number.parseInt(value, 10)
  return Number.isNaN(parsed) ? 0 : parsed
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}

function downloadFile(name: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  URL.revokeObjectURL(url)
}

export default LoadTestPanel
