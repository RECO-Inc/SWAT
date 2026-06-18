import { isImageTestType } from './loadTypes'
import type {
  LoadConfig,
  LoadSnapshot,
  WorkerInbound,
  WorkerOutbound,
} from './loadTypes'

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
  }
}

function emitProgress(): void {
  pruneCompletions(performance.now())
  ctx.postMessage({ type: 'progress', snapshot: buildSnapshot(running) })
}

function buildRequest(
  config: LoadConfig,
  imageBlob: Blob | undefined,
  parsedTemplate: unknown,
  workerId: number,
  seq: number,
): { url: string; init: RequestInit } {
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
        : '/api/weighing-slip/upload'
    return {
      url: `${config.apiBaseUrl}${path}`,
      init: { method: 'POST', headers, body: formData },
    }
  }

  headers['Content-Type'] = 'application/json'

  if (config.testType === 'weighing-data-bulk') {
    const size = Math.max(1, config.bulkSize ?? 1)
    const items = Array.from({ length: size }, () => parsedTemplate)
    return {
      url: `${config.apiBaseUrl}/api/weighing-data/bulk`,
      init: { method: 'POST', headers, body: JSON.stringify({ items }) },
    }
  }

  return {
    url: `${config.apiBaseUrl}/api/weighing-data`,
    init: { method: 'POST', headers, body: JSON.stringify(parsedTemplate) },
  }
}

async function fireRequest(
  config: LoadConfig,
  imageBlob: Blob | undefined,
  parsedTemplate: unknown,
  workerId: number,
  seq: number,
): Promise<void> {
  sent++
  inFlight++
  const start = performance.now()
  try {
    const { url, init } = buildRequest(config, imageBlob, parsedTemplate, workerId, seq)
    const response = await fetch(url, init)
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
    await response.arrayBuffer().catch(() => undefined)
  } catch (error) {
    const latency = performance.now() - start
    latencies.push(latency)
    completionTimes.push(performance.now())
    fail++
    statusCounts.network = (statusCounts.network ?? 0) + 1
    recordError(error instanceof Error ? error.message : 'network error')
  } finally {
    inFlight--
  }
}

async function runLogicalWorker(
  config: LoadConfig,
  imageBlob: Blob | undefined,
  parsedTemplate: unknown,
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
      void fireRequest(config, imageBlob, parsedTemplate, workerId, seq)
      const drift = performance.now() - tickStart
      await sleep(intervalMs - drift)
    } else {
      await fireRequest(config, imageBlob, parsedTemplate, workerId, seq)
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

  let parsedTemplate: unknown
  if (!isImageTestType(config.testType)) {
    try {
      parsedTemplate = JSON.parse(config.jsonTemplate ?? '{}')
    } catch {
      ctx.postMessage({ type: 'error', message: 'JSON template is not valid JSON.' })
      return
    }
  }

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
    runLogicalWorker(config, imageBlob, parsedTemplate, id),
  )

  await Promise.all(workers)
  running = false
  await drainInFlight()

  if (progressTimer) clearInterval(progressTimer)
  ctx.postMessage({ type: 'done', snapshot: buildSnapshot(false) })
}

ctx.onmessage = (event: MessageEvent<WorkerInbound>) => {
  const message = event.data
  if (message.type === 'start') {
    void startLoad(message.config)
  } else if (message.type === 'stop') {
    running = false
  }
}
