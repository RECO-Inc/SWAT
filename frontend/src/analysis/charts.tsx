export type LineSeries = {
  label: string
  color: string
  points: Array<{ x: number; y: number }>
}

type LineChartProps = {
  series: LineSeries[]
  height?: number
  xSuffix?: string
  ySuffix?: string
}

const WIDTH = 720
const PAD = { top: 16, right: 16, bottom: 36, left: 52 }

export function LineChart({
  series,
  height = 260,
  xSuffix = '',
  ySuffix = '',
}: LineChartProps) {
  const allPoints = series.flatMap((s) => s.points)
  if (allPoints.length === 0) {
    return <ChartEmpty height={height} />
  }

  const xs = allPoints.map((p) => p.x)
  const ys = allPoints.map((p) => p.y)
  const xMin = Math.min(...xs)
  const xMax = Math.max(...xs)
  const yMax = niceMax(Math.max(...ys, 0))
  const yMin = 0

  const plotW = WIDTH - PAD.left - PAD.right
  const plotH = height - PAD.top - PAD.bottom

  const scaleX = (x: number) =>
    PAD.left + (xMax === xMin ? 0 : ((x - xMin) / (xMax - xMin)) * plotW)
  const scaleY = (y: number) =>
    PAD.top + (yMax === yMin ? plotH : plotH - ((y - yMin) / (yMax - yMin)) * plotH)

  const yTicks = buildTicks(yMin, yMax, 4)
  const xTicks = buildTicks(xMin, xMax, 6)

  return (
    <div className="chart">
      <div className="chart-legend">
        {series.map((s) => (
          <span key={s.label} className="legend-item">
            <span className="legend-swatch" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
      <svg
        className="chart-svg"
        viewBox={`0 0 ${WIDTH} ${height}`}
        role="img"
        preserveAspectRatio="xMidYMid meet"
      >
        {yTicks.map((tick) => {
          const y = scaleY(tick)
          return (
            <g key={`y-${tick}`}>
              <line
                x1={PAD.left}
                y1={y}
                x2={WIDTH - PAD.right}
                y2={y}
                className="chart-grid"
              />
              <text x={PAD.left - 8} y={y + 4} className="chart-axis-label end">
                {formatTick(tick)}
                {ySuffix}
              </text>
            </g>
          )
        })}

        {xTicks.map((tick) => {
          const x = scaleX(tick)
          return (
            <text
              key={`x-${tick}`}
              x={x}
              y={height - PAD.bottom + 20}
              className="chart-axis-label mid"
            >
              {formatTick(tick)}
              {xSuffix}
            </text>
          )
        })}

        <line
          x1={PAD.left}
          y1={height - PAD.bottom}
          x2={WIDTH - PAD.right}
          y2={height - PAD.bottom}
          className="chart-axis"
        />

        {series.map((s) => (
          <polyline
            key={s.label}
            className="chart-line"
            fill="none"
            stroke={s.color}
            points={s.points
              .map((p) => `${scaleX(p.x)},${scaleY(p.y)}`)
              .join(' ')}
          />
        ))}
      </svg>
    </div>
  )
}

export type BarDatum = { label: string; value: number; color?: string }

export function BarChart({
  data,
  height = 220,
}: {
  data: BarDatum[]
  height?: number
}) {
  if (data.length === 0) {
    return <ChartEmpty height={height} />
  }

  const yMax = niceMax(Math.max(...data.map((d) => d.value), 0))
  const plotW = WIDTH - PAD.left - PAD.right
  const plotH = height - PAD.top - PAD.bottom
  const slot = plotW / data.length
  const barWidth = Math.min(72, slot * 0.6)
  const yTicks = buildTicks(0, yMax, 4)

  return (
    <div className="chart">
      <svg
        className="chart-svg"
        viewBox={`0 0 ${WIDTH} ${height}`}
        role="img"
        preserveAspectRatio="xMidYMid meet"
      >
        {yTicks.map((tick) => {
          const y =
            PAD.top + (yMax === 0 ? plotH : plotH - (tick / yMax) * plotH)
          return (
            <g key={`y-${tick}`}>
              <line
                x1={PAD.left}
                y1={y}
                x2={WIDTH - PAD.right}
                y2={y}
                className="chart-grid"
              />
              <text x={PAD.left - 8} y={y + 4} className="chart-axis-label end">
                {formatTick(tick)}
              </text>
            </g>
          )
        })}

        {data.map((d, index) => {
          const barHeight = yMax === 0 ? 0 : (d.value / yMax) * plotH
          const x = PAD.left + slot * index + (slot - barWidth) / 2
          const y = PAD.top + plotH - barHeight
          return (
            <g key={d.label}>
              <rect
                x={x}
                y={y}
                width={barWidth}
                height={barHeight}
                rx={2}
                fill={d.color ?? '#264870'}
              />
              <text
                x={x + barWidth / 2}
                y={y - 6}
                className="chart-axis-label mid"
              >
                {formatTick(d.value)}
              </text>
              <text
                x={x + barWidth / 2}
                y={height - PAD.bottom + 20}
                className="chart-axis-label mid"
              >
                {d.label}
              </text>
            </g>
          )
        })}

        <line
          x1={PAD.left}
          y1={height - PAD.bottom}
          x2={WIDTH - PAD.right}
          y2={height - PAD.bottom}
          className="chart-axis"
        />
      </svg>
    </div>
  )
}

function ChartEmpty({ height }: { height: number }) {
  return (
    <div className="chart-empty" style={{ height }}>
      표시할 데이터가 없습니다.
    </div>
  )
}

function niceMax(value: number): number {
  if (value <= 0) return 1
  const exponent = Math.floor(Math.log10(value))
  const base = 10 ** exponent
  const normalized = value / base
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10
  return step * base
}

function buildTicks(min: number, max: number, count: number): number[] {
  if (max === min) return [min]
  const step = (max - min) / count
  const ticks: number[] = []
  for (let i = 0; i <= count; i++) {
    ticks.push(min + step * i)
  }
  return ticks
}

function formatTick(value: number): string {
  if (Math.abs(value) >= 1000) return `${Math.round(value / 100) / 10}k`
  if (Number.isInteger(value)) return String(value)
  return value.toFixed(1)
}
