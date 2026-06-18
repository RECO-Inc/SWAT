import { useMemo, useState } from 'react'
import type { RunRecord } from '../load/loadTypes'
import { BarChart, LineChart, type LineSeries } from './charts'

type Props = {
  runs: RunRecord[]
  onClear: () => void
}

const TEST_TYPE_LABELS: Record<string, string> = {
  'image-upload': '이미지 업로드 (비동기 OCR)',
  'image-upload-sync': '이미지 업로드 (동기 OCR)',
  'weighing-data': '계근 데이터 단건',
  'weighing-data-bulk': '계근 데이터 벌크',
}

const COLORS = {
  tps: '#264870',
  avg: '#1a8766',
  p95: '#e46f00',
  p99: '#e11d1d',
  success: '#1a8766',
  fail: '#e11d1d',
  sent: '#385b85',
}

function AnalysisView({ runs, onClear }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const selected = useMemo(() => {
    if (runs.length === 0) return null
    return runs.find((run) => run.id === selectedId) ?? runs[0]
  }, [runs, selectedId])

  if (!selected) {
    return (
      <section className="panel">
        <div className="panel-heading">
          <div>
            <p className="section-kicker">Analysis</p>
            <h2>결과 분석</h2>
          </div>
        </div>
        <div className="status-card">
          <span className="status-card-icon" aria-hidden="true">
            i
          </span>
          <div className="status-card-body">
            <strong>아직 분석할 테스트 결과가 없습니다.</strong>
            <span className="hint">
              부하 테스트를 한 번 실행하면 시계열 그래프와 통계가 여기에 표시됩니다.
            </span>
          </div>
        </div>
      </section>
    )
  }

  const tpsStats = describe(selected.samples.map((s) => s.currentTps))
  const successRate =
    selected.final.sent > 0
      ? (selected.final.success / selected.final.sent) * 100
      : 0

  const tpsSeries: LineSeries[] = [
    {
      label: '현재 TPS',
      color: COLORS.tps,
      points: selected.samples.map((s) => ({ x: s.t, y: s.currentTps })),
    },
  ]

  const latencySeries: LineSeries[] = [
    {
      label: '평균',
      color: COLORS.avg,
      points: selected.samples.map((s) => ({ x: s.t, y: s.avgLatencyMs })),
    },
    {
      label: 'p95',
      color: COLORS.p95,
      points: selected.samples.map((s) => ({ x: s.t, y: s.p95LatencyMs })),
    },
    {
      label: 'p99',
      color: COLORS.p99,
      points: selected.samples.map((s) => ({ x: s.t, y: s.p99LatencyMs })),
    },
  ]

  const cumulativeSeries: LineSeries[] = [
    {
      label: '성공',
      color: COLORS.success,
      points: selected.samples.map((s) => ({ x: s.t, y: s.success })),
    },
    {
      label: '실패',
      color: COLORS.fail,
      points: selected.samples.map((s) => ({ x: s.t, y: s.fail })),
    },
  ]

  const statusData = Object.entries(selected.final.statusCounts).map(
    ([code, count]) => ({
      label: code,
      value: count,
      color: code.startsWith('2') ? COLORS.success : COLORS.fail,
    }),
  )

  return (
    <>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <p className="section-kicker">Analysis</p>
            <h2>결과 분석</h2>
          </div>
          <div className="action-row">
            <label className="field inline-field">
              <span>테스트 선택</span>
              <select
                value={selected.id}
                onChange={(event) => setSelectedId(event.target.value)}
              >
                {runs.map((run) => (
                  <option key={run.id} value={run.id}>
                    {formatRunLabel(run)}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="button secondary" onClick={onClear}>
              기록 삭제
            </button>
          </div>
        </div>

        <div className="metric-grid">
          <Stat label="총 전송" value={selected.final.sent} />
          <Stat label="성공" value={selected.final.success} tone="success" />
          <Stat
            label="실패"
            value={selected.final.fail}
            tone={selected.final.fail > 0 ? 'error' : undefined}
          />
          <Stat label="성공률" value={`${successRate.toFixed(1)}%`} />
          <Stat label="평균 TPS" value={round(tpsStats.mean)} />
          <Stat label="최대 TPS" value={round(tpsStats.max)} />
          <Stat label="TPS 표준편차" value={round(tpsStats.stddev)} />
          <Stat label="평균(ms)" value={round(selected.final.avgLatencyMs)} />
          <Stat label="p95(ms)" value={round(selected.final.p95LatencyMs)} />
          <Stat label="p99(ms)" value={round(selected.final.p99LatencyMs)} />
          <Stat label="최대(ms)" value={round(selected.final.maxLatencyMs)} />
          <Stat label="소요(초)" value={round(selected.final.elapsedSec)} />
        </div>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <p className="section-kicker">Throughput</p>
            <h2>시간별 TPS</h2>
          </div>
        </div>
        <LineChart series={tpsSeries} xSuffix="s" />
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <p className="section-kicker">Latency</p>
            <h2>시간별 지연(ms)</h2>
          </div>
        </div>
        <LineChart series={latencySeries} xSuffix="s" />
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <p className="section-kicker">Outcome</p>
            <h2>누적 성공/실패</h2>
          </div>
        </div>
        <LineChart series={cumulativeSeries} xSuffix="s" />
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <p className="section-kicker">Status</p>
            <h2>상태코드 분포</h2>
          </div>
        </div>
        <BarChart data={statusData} />
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <p className="section-kicker">Comparison</p>
            <h2>실행 비교</h2>
          </div>
        </div>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>시작 시각</th>
                <th>종류</th>
                <th>워커</th>
                <th>워커TPS</th>
                <th>전송</th>
                <th>성공률</th>
                <th>평균TPS</th>
                <th>p95</th>
                <th>p99</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => {
                const rate =
                  run.final.sent > 0
                    ? (run.final.success / run.final.sent) * 100
                    : 0
                const mean = describe(
                  run.samples.map((s) => s.currentTps),
                ).mean
                return (
                  <tr
                    key={run.id}
                    className={run.id === selected.id ? 'active' : undefined}
                  >
                    <td>{formatTime(run.startedAt)}</td>
                    <td>{TEST_TYPE_LABELS[run.testType] ?? run.testType}</td>
                    <td>{run.workerCount}</td>
                    <td>{run.workerTps}</td>
                    <td>{run.final.sent}</td>
                    <td>{rate.toFixed(1)}%</td>
                    <td>{round(mean)}</td>
                    <td>{round(run.final.p95LatencyMs)}</td>
                    <td>{round(run.final.p99LatencyMs)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  )
}

function Stat({
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

function describe(values: number[]): {
  mean: number
  max: number
  stddev: number
} {
  if (values.length === 0) return { mean: 0, max: 0, stddev: 0 }
  const mean = values.reduce((acc, v) => acc + v, 0) / values.length
  const variance =
    values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length
  return { mean, max: Math.max(...values), stddev: Math.sqrt(variance) }
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}

function formatRunLabel(run: RunRecord): string {
  const type = TEST_TYPE_LABELS[run.testType] ?? run.testType
  return `${formatTime(run.startedAt)} · ${type} · ${run.workerCount}w`
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleTimeString()
}

export default AnalysisView
