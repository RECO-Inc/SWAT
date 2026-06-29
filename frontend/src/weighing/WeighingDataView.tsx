import { useMemo, useState } from 'react'
import {
  buildComparison,
  downloadJson,
  generateWeighingPayload,
  type BulkWeighingResponse,
  type ComparisonPayload,
  type CreateWeighingResponse,
  type GeneratedWeighingPayload,
} from './weighingGenerator'

type Props = {
  apiBaseUrl: string
  testRunId: string
  deviceId: string
}

type SendMode = 'single' | 'bulk'

type SendResult = {
  status: number
  mode: SendMode
  body: CreateWeighingResponse | BulkWeighingResponse | { responses: Array<{ status: number; body: CreateWeighingResponse }> }
  sentAt: string
}

function stamp() {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

export default function WeighingDataView({ apiBaseUrl, testRunId, deviceId }: Props) {
  const [count, setCount] = useState(10)
  const [mode, setMode] = useState<SendMode>('bulk')
  const [generated, setGenerated] = useState<GeneratedWeighingPayload | null>(null)
  const [sendResult, setSendResult] = useState<SendResult | null>(null)
  const [comparison, setComparison] = useState<ComparisonPayload | null>(null)
  const [serverItems, setServerItems] = useState<unknown>(null)
  const [message, setMessage] = useState('가상 계근 샘플을 생성한 뒤 API 응답과 비교 파일을 내려받을 수 있습니다.')
  const [busy, setBusy] = useState(false)

  const summary = useMemo(() => {
    if (!generated) return '생성된 데이터 없음'
    return `${generated.count}건 · 프로필 ${generated.profile}`
  }, [generated])

  function handleGenerate() {
    const payload = generateWeighingPayload(Math.max(1, count))
    setGenerated(payload)
    setSendResult(null)
    setComparison(null)
    setMessage(`${payload.count}건의 가상 계근 JSON을 생성했습니다.`)
  }

  function handleDownloadGenerated() {
    if (!generated) {
      setMessage('먼저 가상 데이터를 생성하세요.')
      return
    }
    downloadJson(`weighing_generated_${stamp()}.json`, generated)
    setMessage('생성 JSON을 다운로드했습니다.')
  }

  async function handleSend() {
    if (!generated) {
      setMessage('먼저 가상 데이터를 생성하세요.')
      return
    }

    setBusy(true)
    setMessage('API로 계근 데이터를 전송하는 중...')
    try {
      const headers = {
        'Content-Type': 'application/json',
        'X-Test-Run-Id': testRunId,
        'X-Test-Client-Type': 'web',
        'X-Test-Device-Id': deviceId,
      }

      if (mode === 'bulk') {
        const response = await fetch(`${apiBaseUrl}/api/weighing-data/bulk`, {
          method: 'POST',
          headers: {
            ...headers,
            'X-Test-Worker-Id': 'worker-001',
            'X-Test-Request-Seq': '000001',
          },
          body: JSON.stringify({ items: generated.items }),
        })
        const body = (await response.json()) as BulkWeighingResponse
        if (!response.ok) {
          throw new Error(typeof body === 'object' && body && 'error' in body ? String((body as { error: string }).error) : `HTTP ${response.status}`)
        }
        const result: SendResult = {
          status: response.status,
          mode,
          body,
          sentAt: new Date().toISOString(),
        }
        setSendResult(result)
        setComparison(buildComparison(generated, body))
        setMessage(`벌크 전송 완료 (HTTP ${response.status}, ${body.rowCount}건 저장).`)
        return
      }

      const responses: Array<{ status: number; body: CreateWeighingResponse }> = []
      let lastStatus = 0
      for (const [index, item] of generated.items.entries()) {
        const response = await fetch(`${apiBaseUrl}/api/weighing-data`, {
          method: 'POST',
          headers: {
            ...headers,
            'X-Test-Worker-Id': `worker-${String(index + 1).padStart(3, '0')}`,
            'X-Test-Request-Seq': String(index + 1).padStart(6, '0'),
          },
          body: JSON.stringify(item),
        })
        const body = (await response.json()) as CreateWeighingResponse
        lastStatus = response.status
        if (!response.ok) {
          throw new Error(typeof body === 'object' && body && 'error' in body ? String((body as { error: string }).error) : `HTTP ${response.status}`)
        }
        responses.push({ status: response.status, body })
      }

      const result: SendResult = {
        status: lastStatus,
        mode,
        body: { responses },
        sentAt: new Date().toISOString(),
      }
      setSendResult(result)
      setComparison(buildComparison(generated, result.body))
      setMessage(`단건 전송 완료 (${generated.count}건).`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'API 전송에 실패했습니다.')
    } finally {
      setBusy(false)
    }
  }

  function handleDownloadResponse() {
    if (!sendResult) {
      setMessage('먼저 API로 데이터를 전송하세요.')
      return
    }
    downloadJson(`weighing_response_${stamp()}.json`, sendResult)
    setMessage('API 응답 JSON을 다운로드했습니다.')
  }

  function handleDownloadComparison() {
    if (!comparison) {
      setMessage('비교 데이터가 없습니다. 전송 후 다시 시도하세요.')
      return
    }
    downloadJson(`weighing_comparison_${stamp()}.json`, comparison)
    setMessage('전후 비교 JSON을 다운로드했습니다.')
  }

  async function handleFetchServer() {
    setBusy(true)
    setMessage('서버에 저장된 계근 데이터를 조회하는 중...')
    try {
      const params = new URLSearchParams({ testRunId, limit: '500' })
      const response = await fetch(`${apiBaseUrl}/api/weighing-data?${params.toString()}`)
      const body = await response.json()
      if (!response.ok) {
        throw new Error(typeof body === 'object' && body && 'error' in body ? String(body.error) : `HTTP ${response.status}`)
      }
      setServerItems(body)
      setMessage(`서버 저장 데이터 ${body.count ?? body.items?.length ?? 0}건을 조회했습니다.`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '서버 조회에 실패했습니다.')
    } finally {
      setBusy(false)
    }
  }

  function handleDownloadServer() {
    if (!serverItems) {
      setMessage('먼저 서버 저장 데이터를 조회하세요.')
      return
    }
    downloadJson(`weighing_server_${stamp()}.json`, serverItems)
    setMessage('서버 저장 JSON을 다운로드했습니다.')
  }

  return (
    <div className="weighing-view">
      <div className="page-head">
        <h1>계근 데이터 샘플 생성</h1>
        <p className="page-desc">
          실제 계근 CSV 분포를 기반으로 JSON 샘플을 생성하고 API 응답·서버 저장 결과와
          비교합니다.
        </p>
      </div>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <p className="section-kicker">Generate</p>
            <h2>샘플 데이터 생성</h2>
          </div>
        </div>

        <div className="form-grid">
          <label className="field">
            <span>생성 건수</span>
            <input
              type="number"
              min={1}
              max={500}
              value={count}
              onChange={(event) => setCount(Number(event.target.value))}
            />
          </label>
          <label className="field">
            <span>전송 방식</span>
            <select value={mode} onChange={(event) => setMode(event.target.value as SendMode)}>
              <option value="bulk">벌크 (/api/weighing-data/bulk)</option>
              <option value="single">단건 반복 (/api/weighing-data)</option>
            </select>
          </label>
        </div>

        <p className="hint">{summary}</p>

        <div className="action-row">
          <button type="button" className="button primary" onClick={handleGenerate}>
            가상 데이터 생성
          </button>
          <button
            type="button"
            className="button secondary"
            onClick={handleDownloadGenerated}
            disabled={!generated}
          >
            생성 JSON 다운로드
          </button>
          <button type="button" className="button primary" onClick={handleSend} disabled={!generated || busy}>
            샘플 API 전송
          </button>
        </div>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <p className="section-kicker">Compare</p>
            <h2>샘플 전송 결과 / 비교 다운로드</h2>
          </div>
        </div>

        <div className="action-row">
          <button type="button" className="button secondary" onClick={handleDownloadResponse} disabled={!sendResult}>
            API 응답 다운로드
          </button>
          <button type="button" className="button secondary" onClick={handleDownloadComparison} disabled={!comparison}>
            전후 비교 다운로드
          </button>
          <button type="button" className="button secondary" onClick={handleFetchServer} disabled={busy}>
            서버 저장 조회
          </button>
          <button type="button" className="button secondary" onClick={handleDownloadServer} disabled={!serverItems}>
            서버 저장 다운로드
          </button>
        </div>

        {comparison ? (
          <div className="result-box">
            <p>
              비교 결과: {comparison.matchedCount}/{comparison.sentCount}건 일치
            </p>
          </div>
        ) : null}

        {generated ? (
          <details className="json-preview">
            <summary>생성 JSON 미리보기</summary>
            <pre>{JSON.stringify(generated, null, 2)}</pre>
          </details>
        ) : null}

        {sendResult ? (
          <details className="json-preview">
            <summary>API 응답 미리보기</summary>
            <pre>{JSON.stringify(sendResult, null, 2)}</pre>
          </details>
        ) : null}
      </section>

      <p className="hint">{message}</p>
    </div>
  )
}
