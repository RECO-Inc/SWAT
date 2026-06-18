import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

type Props = {
  apiBaseUrl: string
}

interface OcrStatusItem {
  uploadId: string
  fileName: string
  sizeBytes: number
  mode: string
  status: string
  ocrStatusCode?: number
  latencyMs?: number
  error?: string
  result?: unknown
  queuedAt: string
  startedAt?: string
  finishedAt?: string
}

interface OcrStatusSummary {
  enabled: boolean
  queueDepth: number
  queueCapacity: number
  pending: number
}

interface OcrStatusResponse {
  summary: OcrStatusSummary & Record<string, unknown>
  items: OcrStatusItem[]
}

type ItemMap = Record<string, OcrStatusItem>

const STORAGE_KEY = 'swat.ocr.items.v1'
const MAX_STORED = 3000
const POLL_LIMIT = 500

const STATUS_LABELS: Record<string, string> = {
  pending: '대기/처리중',
  done: '완료',
  error: '실패',
  dropped: '드롭',
  disabled: '비활성',
}

const STATUS_FILTERS = ['', 'pending', 'done', 'error', 'dropped', 'disabled']

function ts(item: OcrStatusItem): number {
  const value = Date.parse(item.queuedAt)
  return Number.isNaN(value) ? 0 : value
}

function loadStored(): ItemMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as ItemMap
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function saveStored(map: ItemMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // localStorage full or unavailable: keep running with in-memory data only.
  }
}

function mergeAndCap(prev: ItemMap, incoming: OcrStatusItem[]): ItemMap {
  const next: ItemMap = { ...prev }
  for (const item of incoming) {
    next[item.uploadId] = item
  }
  const values = Object.values(next)
  if (values.length <= MAX_STORED) return next
  values.sort((a, b) => ts(b) - ts(a))
  const capped: ItemMap = {}
  for (const item of values.slice(0, MAX_STORED)) capped[item.uploadId] = item
  return capped
}

function countByStatus(items: OcrStatusItem[]): Record<string, number> {
  const counts: Record<string, number> = {
    pending: 0,
    done: 0,
    error: 0,
    dropped: 0,
    disabled: 0,
  }
  for (const item of items) {
    counts[item.status] = (counts[item.status] ?? 0) + 1
  }
  return counts
}

function toLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function OcrStatusView({ apiBaseUrl }: Props) {
  const [items, setItems] = useState<ItemMap>(() => loadStored())
  const itemsRef = useRef<ItemMap>(items)

  const [realtime, setRealtime] = useState(true)
  const [intervalMs, setIntervalMs] = useState(1500)
  const [statusFilter, setStatusFilter] = useState('')
  const [liveSummary, setLiveSummary] = useState<OcrStatusSummary | null>(null)
  const [error, setError] = useState('')
  const [throughput, setThroughput] = useState(0)
  const rateRef = useRef<{ t: number; done: number } | null>(null)

  const [fromInput, setFromInput] = useState('')
  const [toInput, setToInput] = useState('')
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(50)
  const [detailId, setDetailId] = useState<string | null>(null)

  const fetchOnce = useCallback(async () => {
    try {
      const response = await fetch(
        `${apiBaseUrl}/api/weighing-slip/ocr-status?limit=${POLL_LIMIT}`,
      )
      if (!response.ok) {
        throw new Error(`상태 조회 실패 (${response.status})`)
      }
      const payload = (await response.json()) as OcrStatusResponse

      const merged = mergeAndCap(itemsRef.current, payload.items ?? [])
      itemsRef.current = merged
      saveStored(merged)
      setItems(merged)
      setLiveSummary({
        enabled: Boolean(payload.summary?.enabled),
        queueDepth: Number(payload.summary?.queueDepth ?? 0),
        queueCapacity: Number(payload.summary?.queueCapacity ?? 0),
        pending: Number(payload.summary?.pending ?? 0),
      })
      setError('')

      const values = Object.values(merged)
      const done =
        values.filter((item) => item.status === 'done' || item.status === 'error')
          .length
      const now = performance.now()
      const prev = rateRef.current
      if (prev && now > prev.t) {
        setThroughput(Math.max(0, ((done - prev.done) / (now - prev.t)) * 1000))
      }
      rateRef.current = { t: now, done }
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : '상태 조회 실패')
    }
  }, [apiBaseUrl])

  useEffect(() => {
    if (!realtime) return
    const tick = () => {
      void fetchOnce()
    }
    const initial = setTimeout(tick, 0)
    const timer = setInterval(tick, Math.max(500, intervalMs))
    return () => {
      clearTimeout(initial)
      clearInterval(timer)
    }
  }, [realtime, intervalMs, fetchOnce])

  const fromTs = fromInput ? new Date(fromInput).getTime() : null
  const toTs = toInput ? new Date(toInput).getTime() : null

  const allSorted = useMemo(
    () => Object.values(items).sort((a, b) => ts(b) - ts(a)),
    [items],
  )

  const rangeSet = useMemo(() => {
    if (realtime) return allSorted
    return allSorted.filter((item) => {
      const t = ts(item)
      if (fromTs !== null && t < fromTs) return false
      if (toTs !== null && t > toTs) return false
      return true
    })
  }, [allSorted, realtime, fromTs, toTs])

  const counts = useMemo(() => countByStatus(rangeSet), [rangeSet])

  const tableSet = useMemo(
    () => (statusFilter ? rangeSet.filter((item) => item.status === statusFilter) : rangeSet),
    [rangeSet, statusFilter],
  )

  const total = tableSet.length
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const safePage = Math.min(page, pageCount - 1)
  const pageItems = tableSet.slice(safePage * pageSize, safePage * pageSize + pageSize)

  const detail = detailId ? items[detailId] : null

  function setQuickRange(minutes: number | 'all') {
    setPage(0)
    setRealtime(false)
    if (minutes === 'all') {
      if (allSorted.length === 0) {
        setFromInput('')
        setToInput('')
        return
      }
      const oldest = new Date(ts(allSorted[allSorted.length - 1]))
      const newest = new Date(ts(allSorted[0]))
      setFromInput(toLocalInput(oldest))
      setToInput(toLocalInput(new Date(newest.getTime() + 60000)))
      return
    }
    const now = new Date()
    setFromInput(toLocalInput(new Date(now.getTime() - minutes * 60000)))
    setToInput(toLocalInput(new Date(now.getTime() + 60000)))
  }

  function clearStored() {
    if (!window.confirm('저장된 OCR 현황 기록을 모두 지울까요?')) return
    itemsRef.current = {}
    saveStored({})
    setItems({})
    rateRef.current = null
    setThroughput(0)
    setDetailId(null)
  }

  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <p className="section-kicker">OCR Pipeline</p>
          <h2>OCR 처리 현황</h2>
        </div>
        <div className="action-row wrap" style={{ margin: 0 }}>
          <label className="inline-check">
            <input
              type="checkbox"
              checked={realtime}
              onChange={(event) => {
                setPage(0)
                setRealtime(event.target.checked)
              }}
            />
            <span>실시간 보기</span>
          </label>
          <select
            value={intervalMs}
            onChange={(event) => setIntervalMs(Number(event.target.value))}
            disabled={!realtime}
          >
            <option value={1000}>1초</option>
            <option value={1500}>1.5초</option>
            <option value={3000}>3초</option>
            <option value={5000}>5초</option>
          </select>
          <button type="button" className="button secondary" onClick={() => void fetchOnce()}>
            지금 가져오기
          </button>
          <button type="button" className="button ghost" onClick={clearStored}>
            기록 초기화
          </button>
        </div>
      </div>

      {liveSummary && !liveSummary.enabled ? (
        <div className="status-card error" role="status">
          <span className="status-card-icon" aria-hidden="true">
            !
          </span>
          <div className="status-card-body">
            <strong>OCR 서비스가 비활성화 상태입니다 (OCR_API_URL 미설정).</strong>
          </div>
        </div>
      ) : null}

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
        <Metric label={realtime ? '누적 건수' : '구간 건수'} value={rangeSet.length} />
        <Metric label="완료" value={counts.done} tone="success" />
        <Metric label="실패" value={counts.error} tone={counts.error > 0 ? 'error' : undefined} />
        <Metric label="드롭" value={counts.dropped} tone={counts.dropped > 0 ? 'error' : undefined} />
        <Metric label="대기/처리중" value={counts.pending} />
        {realtime ? (
          <>
            <Metric label="큐 대기(현재)" value={liveSummary?.queueDepth ?? 0} />
            <Metric label="OCR 처리속도" value={`${throughput.toFixed(1)}/s`} />
          </>
        ) : null}
      </div>

      {!realtime ? (
        <div className="range-bar">
          <label className="field">
            <span>시작</span>
            <input
              type="datetime-local"
              value={fromInput}
              onChange={(event) => {
                setPage(0)
                setFromInput(event.target.value)
              }}
            />
          </label>
          <label className="field">
            <span>종료</span>
            <input
              type="datetime-local"
              value={toInput}
              onChange={(event) => {
                setPage(0)
                setToInput(event.target.value)
              }}
            />
          </label>
          <div className="quick-range">
            <button type="button" className="button ghost small" onClick={() => setQuickRange(5)}>
              최근 5분
            </button>
            <button type="button" className="button ghost small" onClick={() => setQuickRange(10)}>
              최근 10분
            </button>
            <button type="button" className="button ghost small" onClick={() => setQuickRange(30)}>
              최근 30분
            </button>
            <button type="button" className="button ghost small" onClick={() => setQuickRange('all')}>
              전체
            </button>
          </div>
        </div>
      ) : null}

      <div className="form-grid" style={{ marginTop: 12 }}>
        <label className="field">
          <span>상태 필터</span>
          <select
            value={statusFilter}
            onChange={(event) => {
              setPage(0)
              setStatusFilter(event.target.value)
            }}
          >
            {STATUS_FILTERS.map((value) => (
              <option key={value || 'all'} value={value}>
                {value ? STATUS_LABELS[value] : '전체'}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>페이지 크기</span>
          <select
            value={pageSize}
            onChange={(event) => {
              setPage(0)
              setPageSize(Number(event.target.value))
            }}
          >
            <option value={25}>25</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
            <option value={200}>200</option>
          </select>
        </label>
      </div>

      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>접수시각</th>
              <th>uploadId</th>
              <th>파일</th>
              <th>모드</th>
              <th>상태</th>
              <th>지연(ms)</th>
              <th>비고</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {pageItems.length === 0 ? (
              <tr>
                <td colSpan={8} className="table-empty">
                  표시할 항목이 없습니다.
                </td>
              </tr>
            ) : (
              pageItems.map((item) => (
                <tr key={item.uploadId}>
                  <td>{formatTime(item.queuedAt)}</td>
                  <td className="mono">{shortId(item.uploadId)}</td>
                  <td>{item.fileName || '-'}</td>
                  <td>{item.mode}</td>
                  <td>
                    <span className={`ocr-badge ocr-${item.status}`}>
                      {STATUS_LABELS[item.status] ?? item.status}
                    </span>
                  </td>
                  <td>{item.latencyMs ? Math.round(item.latencyMs) : '-'}</td>
                  <td className="cell-error">
                    {item.error
                      ? item.error
                      : item.ocrStatusCode
                        ? `HTTP ${item.ocrStatusCode}`
                        : '-'}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="button ghost small"
                      onClick={() => setDetailId(item.uploadId)}
                      disabled={item.result === undefined}
                    >
                      결과
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="pager">
        <span className="hint">
          {total === 0
            ? '0건'
            : `${safePage * pageSize + 1}–${Math.min(total, (safePage + 1) * pageSize)} / ${total}건`}
        </span>
        <div className="action-row" style={{ margin: 0 }}>
          <button
            type="button"
            className="button ghost small"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={safePage <= 0}
          >
            이전
          </button>
          <span className="hint">
            {safePage + 1} / {pageCount}
          </span>
          <button
            type="button"
            className="button ghost small"
            onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            disabled={safePage >= pageCount - 1}
          >
            다음
          </button>
        </div>
      </div>

      {detail ? (
        <div className="status-card" role="status">
          <div className="status-card-body" style={{ width: '100%' }}>
            <div className="detail-head">
              <strong className="mono">{detail.uploadId}</strong>
              <button type="button" className="button ghost small" onClick={() => setDetailId(null)}>
                닫기
              </button>
            </div>
            <pre>
              {detail.result !== undefined
                ? JSON.stringify(detail.result, null, 2)
                : '저장된 결과가 없습니다.'}
            </pre>
          </div>
        </div>
      ) : null}
    </section>
  )
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

function shortId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 14)}…` : id
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleTimeString()
}

export default OcrStatusView
