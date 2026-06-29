import { isImageTestType } from './loadTypes'
import type {
  LoadEvidence,
  LoadEvidenceItem,
  LoadConfig,
  LoadSnapshot,
  WorkerInbound,
  WorkerOutbound,
} from './loadTypes'
import { generateWeighingItems } from '../weighing/weighingGenerator'

const ctx = self as unknown as {
  postMessage: (message: WorkerOutbound) => void
  onmessage: ((event: MessageEvent<WorkerInbound>) => void) | null
}

const ERROR_LIMIT = 20
const PROGRESS_INTERVAL_MS = 500
const TPS_WINDOW_MS = 1000
const DRAIN_TIMEOUT_MS = 5000

let running = false
let startTime = 0
let endTime = 0

let sent = 0
let success = 0
let fail = 0
let inFlight = 0

const latencies: number[] = []
const completionTimes: number[] = []
const statusCounts: Record<string, number> = {}
const errorCounts: Record<string, number> = {}
const evidenceItems: LoadEvidenceItem[] = []

let evidenceDropped = 0

let progressTimer: ReturnType<typeof setInterval> | undefined

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}

function resetState(): void {
  sent = 0
  success = 0
  fail = 0
  inFlight = 0
  latencies.length = 0
  completionTimes.length = 0
  evidenceItems.length = 0
  evidenceDropped = 0
  for (const key of Object.keys(statusCounts)) delete statusCounts[key]
  for (const key of Object.keys(errorCounts)) delete errorCounts[key]
}

function recordError(message: string): void {
  const key = message.slice(0, 160)
  errorCounts[key] = (errorCounts[key] ?? 0) + 1
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const rank = Math.ceil((p / 100) * sorted.length) - 1
  const index = Math.min(sorted.length - 1, Math.max(0, rank))
  return sorted[index]
}

function currentTps(now: number): number {
  const cutoff = now - TPS_WINDOW_MS
  let count = 0
  for (let i = completionTimes.length - 1; i >= 0; i--) {
    if (completionTimes[i] >= cutoff) count++
    else break
  }
  return count / (TPS_WINDOW_MS / 1000)
}

function pruneCompletions(now: number): void {
  const cutoff = now - TPS_WINDOW_MS * 3
  let removable = 0
  while (removable < completionTimes.length && completionTimes[removable] < cutoff) {
    removable++
  }
  if (removable > 0) completionTimes.splice(0, removable)
}

function buildSnapshot(isRunning: boolean): LoadSnapshot {
  const now = performance.now()
  const sorted = [...latencies].sort((a, b) => a - b)
  const sum = latencies.reduce((acc, value) => acc + value, 0)
  const errors = Object.entries(errorCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, ERROR_LIMIT)
    .map(([message, count]) => `x${count}  ${message}`)

  return {
    running: isRunning,
    elapsedSec: startTime > 0 ? (now - startTime) / 1000 : 0,
    durationSec: endTime === Infinity ? 0 : (endTime - startTime) / 1000,
    sent,
    success,
    fail,
    inFlight,
    currentTps: currentTps(now),
    avgLatencyMs: latencies.length > 0 ? sum / latencies.length : 0,
    p95LatencyMs: percentile(sorted, 95),
    p99LatencyMs: percentile(sorted, 99),
    minLatencyMs: sorted.length > 0 ? sorted[0] : 0,
    maxLatencyMs: sorted.length > 0 ? sorted[sorted.length - 1] : 0,
    statusCounts: { ...statusCounts },
    errors,
    evidenceCaptured: evidenceItems.length,
    evidenceDropped,
  }
}

function emitProgress(): void {
  pruneCompletions(performance.now())
  ctx.postMessage({ type: 'progress', snapshot: buildSnapshot(running) })
}

function buildRequest(
  config: LoadConfig,
  imageBlob: Blob | undefined,
  workerId: number,
  seq: number,
  requestIndex: number,
): { url: string; init: RequestInit; method: string; requestBody?: unknown } {
  const headers: Record<string, string> = {
    'X-Test-Run-Id': config.testRunId,
    'X-Test-Client-Type': 'web',
    'X-Test-Device-Id': config.deviceId,
    'X-Test-Worker-Id': `worker-${String(workerId + 1).padStart(3, '0')}`,
    'X-Test-Request-Seq': String(seq).padStart(6, '0'),
  }
  if (config.authToken.trim()) {
    headers.Authorization = config.authToken.trim()
  }

  if (isImageTestType(config.testType)) {
    const formData = new FormData()
    const blob = imageBlob ?? new Blob([new Uint8Array(0)], { type: 'image/jpeg' })
    formData.append('file', blob, config.imageName ?? 'weighing-slip.jpg')
    const path =
      config.testType === 'image-upload-sync'
        ? '/api/weighing-slip/upload-sync'
        : config.testType === 'image-upload-only'
          ? '/api/weighing-slip/upload-only'
          : '/api/weighing-slip/upload'
    return {
      url: `${config.apiBaseUrl}${path}`,
      init: { method: 'POST', headers, body: formData },
      method: 'POST',
    }
  }

  headers['Content-Type'] = 'application/json'

  if (config.testType === 'weighing-data-bulk') {
    const size = Math.max(1, config.bulkSize ?? 1)
    const items = generateWeighingItems(size, (requestIndex - 1) * size + 1)
    const requestBody = { items }
    return {
      url: `${config.apiBaseUrl}/api/weighing-data/bulk`,
      init: { method: 'POST', headers, body: JSON.stringify(requestBody) },
      method: 'POST',
      requestBody,
    }
  }

  const requestBody = generateWeighingItems(1, requestIndex)[0]
  return {
    url: `${config.apiBaseUrl}/api/weighing-data`,
    init: { method: 'POST', headers, body: JSON.stringify(requestBody) },
    method: 'POST',
    requestBody,
  }
}

function shouldCaptureEvidence(config: LoadConfig): boolean {
  return !isImageTestType(config.testType)
}

function parseBody(text: string): unknown {
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function captureEvidence(config: LoadConfig, item: LoadEvidenceItem): void {
  if (!shouldCaptureEvidence(config)) return

  const limit = Math.max(0, config.evidenceLimit ?? 0)
  if (limit > 0 && evidenceItems.length >= limit) {
    evidenceDropped++
    return
  }
  evidenceItems.push(item)
}

function buildEvidence(): LoadEvidence {
  return {
    capturedCount: evidenceItems.length,
    droppedCount: evidenceDropped,
    items: evidenceItems,
  }
}

async function fireRequest(
  config: LoadConfig,
  imageBlob: Blob | undefined,
  workerId: number,
  seq: number,
): Promise<void> {
  const requestIndex = sent + 1
  sent = requestIndex
  inFlight++
  const start = performance.now()
  let request:
    | { url: string; init: RequestInit; method: string; requestBody?: unknown }
    | undefined
  try {
    request = buildRequest(config, imageBlob, workerId, seq, requestIndex)
    const response = await fetch(request.url, request.init)
    const responseText = await response.text().catch(() => '')
    const latency = performance.now() - start
    latencies.push(latency)
    completionTimes.push(performance.now())

    const code = String(response.status)
    statusCounts[code] = (statusCounts[code] ?? 0) + 1
    if (response.ok) {
      success++
    } else {
      fail++
      recordError(`HTTP ${response.status}`)
    }
    captureEvidence(config, {
      index: requestIndex,
      workerId: `worker-${String(workerId + 1).padStart(3, '0')}`,
      requestSeq: String(seq).padStart(6, '0'),
      method: request.method,
      url: request.url,
      status: response.status,
      ok: response.ok,
      latencyMs: latency,
      completedAt: new Date().toISOString(),
      requestBody: request.requestBody,
      responseBody: parseBody(responseText),
    })
  } catch (error) {
    const latency = performance.now() - start
    latencies.push(latency)
    completionTimes.push(performance.now())
    fail++
    statusCounts.network = (statusCounts.network ?? 0) + 1
    const message = error instanceof Error ? error.message : 'network error'
    recordError(message)
    captureEvidence(config, {
      index: requestIndex,
      workerId: `worker-${String(workerId + 1).padStart(3, '0')}`,
      requestSeq: String(seq).padStart(6, '0'),
      method: request?.method ?? 'POST',
      url: request?.url ?? '',
      status: 'network',
      ok: false,
      latencyMs: latency,
      completedAt: new Date().toISOString(),
      requestBody: request?.requestBody,
      error: message,
    })
  } finally {
    inFlight--
  }
}

async function runLogicalWorker(
  config: LoadConfig,
  imageBlob: Blob | undefined,
  workerId: number,
): Promise<void> {
  const intervalMs = config.workerTps > 0 ? 1000 / config.workerTps : 0

  if (config.rampUpSec > 0 && config.workerCount > 1) {
    await sleep((workerId / config.workerCount) * config.rampUpSec * 1000)
  }

  let seq = 0
  while (running && performance.now() < endTime) {
    seq++
    if (intervalMs > 0) {
      const tickStart = performance.now()
      void fireRequest(config, imageBlob, workerId, seq)
      const drift = performance.now() - tickStart
      await sleep(intervalMs - drift)
    } else {
      await fireRequest(config, imageBlob, workerId, seq)
    }
  }
}

async function drainInFlight(): Promise<void> {
  const deadline = performance.now() + DRAIN_TIMEOUT_MS
  while (inFlight > 0 && performance.now() < deadline) {
    await sleep(50)
  }
}

async function startLoad(config: LoadConfig): Promise<void> {
  if (running) return

  let imageBlob: Blob | undefined
  if (isImageTestType(config.testType) && config.imageBytes) {
    imageBlob = new Blob([config.imageBytes], {
      type: config.imageContentType ?? 'image/jpeg',
    })
  }

  resetState()
  running = true
  startTime = performance.now()
  endTime = config.durationSec > 0 ? startTime + config.durationSec * 1000 : Infinity

  progressTimer = setInterval(emitProgress, PROGRESS_INTERVAL_MS)

  const workers = Array.from({ length: Math.max(1, config.workerCount) }, (_, id) =>
    runLogicalWorker(config, imageBlob, id),
  )

  await Promise.all(workers)
  running = false
  await drainInFlight()

  if (progressTimer) clearInterval(progressTimer)
  ctx.postMessage({
    type: 'done',
    snapshot: buildSnapshot(false),
    evidence: shouldCaptureEvidence(config) ? buildEvidence() : undefined,
  })
}

ctx.onmessage = (event: MessageEvent<WorkerInbound>) => {
  const message = event.data
  if (message.type === 'start') {
    void startLoad(message.config)
  } else if (message.type === 'stop') {
    running = false
  }
}
