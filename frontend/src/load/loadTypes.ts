export type LoadTestType =
  | 'image-upload'
  | 'image-upload-sync'
  | 'weighing-data'
  | 'weighing-data-bulk'

export function isImageTestType(testType: LoadTestType): boolean {
  return testType === 'image-upload' || testType === 'image-upload-sync'
}

export interface LoadConfig {
  apiBaseUrl: string
  testType: LoadTestType
  testRunId: string
  deviceId: string
  authToken: string
  workerCount: number
  /** Requests per second for each logical worker. 0 means max throughput (closed loop). */
  workerTps: number
  durationSec: number
  rampUpSec: number
  imageBytes?: ArrayBuffer
  imageName?: string
  imageContentType?: string
  jsonTemplate?: string
  bulkSize?: number
}

export interface LoadSnapshot {
  running: boolean
  elapsedSec: number
  durationSec: number
  sent: number
  success: number
  fail: number
  inFlight: number
  currentTps: number
  avgLatencyMs: number
  p95LatencyMs: number
  p99LatencyMs: number
  minLatencyMs: number
  maxLatencyMs: number
  statusCounts: Record<string, number>
  errors: string[]
}

export interface LoadSample {
  t: number
  currentTps: number
  avgLatencyMs: number
  p95LatencyMs: number
  p99LatencyMs: number
  sent: number
  success: number
  fail: number
  inFlight: number
}

export interface RunRecord {
  id: string
  startedAt: string
  testType: LoadTestType
  testRunId: string
  workerCount: number
  workerTps: number
  durationSec: number
  samples: LoadSample[]
  final: LoadSnapshot
}

export type WorkerInbound =
  | { type: 'start'; config: LoadConfig }
  | { type: 'stop' }

export type WorkerOutbound =
  | { type: 'progress'; snapshot: LoadSnapshot }
  | { type: 'done'; snapshot: LoadSnapshot }
  | { type: 'error'; message: string }

export function emptySnapshot(durationSec = 0): LoadSnapshot {
  return {
    running: false,
    elapsedSec: 0,
    durationSec,
    sent: 0,
    success: 0,
    fail: 0,
    inFlight: 0,
    currentTps: 0,
    avgLatencyMs: 0,
    p95LatencyMs: 0,
    p99LatencyMs: 0,
    minLatencyMs: 0,
    maxLatencyMs: 0,
    statusCounts: {},
    errors: [],
  }
}
