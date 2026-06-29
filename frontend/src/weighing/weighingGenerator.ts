import profile from './weighing_profile.json'

export type WeighingSourcePayload = {
  num: number
  business: string
  car: string
  product: string
  area: string
  dateFirst: string
  timeFirst: string
  dateSecond: string
  timeSecond: string
  weightFirst: number
  weightSecond: number
  weightGap: number
  inOut: string
  unit: number
  sumMoney: number
  slipNum: number
  cardKeyId: number
  userName?: string
  carName?: string
  note?: string
  chargeFlag?: string
  chargeMoney?: number
  countReWrite?: number
  generated?: boolean
  sourceFile?: string
}

export type WeighingRequestPayload = {
  ticketId: string
  vehicleNo: string
  grossWeightKg: number
  tareWeightKg: number
  source: WeighingSourcePayload
}

export type GeneratedWeighingPayload = {
  generatedAt: string
  profile: string
  count: number
  items: WeighingRequestPayload[]
}

export type WeighingRecord = {
  id: string
  ticketId: string
  vehicleNo: string
  grossWeightKg: number
  tareWeightKg: number
  netWeightKg: number
  recordedAt: string
  trace?: {
    testRunId?: string
    clientType?: string
    deviceId?: string
    workerId?: string
    requestSeq?: string
    requestId?: string
    receivedAtUtc?: string
  }
  source?: WeighingSourcePayload
}

export type CreateWeighingResponse = {
  request: WeighingRequestPayload
  item: WeighingRecord
  trace: WeighingRecord['trace']
}

export type BulkWeighingResponse = {
  requests: WeighingRequestPayload[]
  items: WeighingRecord[]
  apiCount: number
  rowCount: number
  trace: WeighingRecord['trace']
  recordedAt: string
}

export type ComparisonRow = {
  index: number
  sent: WeighingRequestPayload
  stored: WeighingRecord | null
  matched: boolean
}

export type ComparisonPayload = {
  generatedAt?: string
  sentCount: number
  storedCount: number
  matchedCount: number
  rows: ComparisonRow[]
}

type WeightStats = { min: number; max: number; avg: number }

type WeighingProfile = {
  sourceFile: string
  businesses: string[]
  products: string[]
  areas: string[]
  inOuts: string[]
  cars: string[]
  businessProducts: Record<string, string[]>
  weightFirst: WeightStats
  weightSecond: WeightStats
  weightGap: WeightStats
}

const WEIGHING_PROFILE = profile as WeighingProfile

export const WEIGHING_PROFILE_NAME = WEIGHING_PROFILE.sourceFile

function randomInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function pickWeight(stats: WeightStats) {
  const low = Math.max(1, stats.min)
  const high = Math.max(low, stats.max)
  const spread = (high - low) / 6
  const value = Math.round(stats.avg + (Math.random() * 2 - 1) * spread * 2)
  return Math.max(low, Math.min(high, value))
}

function pad(value: number) {
  return String(value).padStart(2, '0')
}

function formatDate(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function formatTime(date: Date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function randomTimePair(now = new Date()) {
  const first = new Date(now.getTime() - randomInt(20, 90) * 60_000)
  const second = new Date(first.getTime() + randomInt(8, 35) * 60_000)
  return {
    dateFirst: formatDate(first),
    timeFirst: formatTime(first),
    dateSecond: formatDate(second),
    timeSecond: formatTime(second),
  }
}

function buildSource(index: number): WeighingSourcePayload {
  const business = WEIGHING_PROFILE.businesses[randomInt(0, WEIGHING_PROFILE.businesses.length - 1)]!
  const productChoices =
    WEIGHING_PROFILE.businessProducts[business] ?? WEIGHING_PROFILE.products
  const product = productChoices[randomInt(0, productChoices.length - 1)]!
  const area = WEIGHING_PROFILE.areas[randomInt(0, WEIGHING_PROFILE.areas.length - 1)]!
  const car = WEIGHING_PROFILE.cars[randomInt(0, WEIGHING_PROFILE.cars.length - 1)]!
  const inOut = Math.random() < 0.75 ? '입고' : '출고'

  let weightFirst = pickWeight(WEIGHING_PROFILE.weightFirst)
  let weightSecond = pickWeight(WEIGHING_PROFILE.weightSecond)
  if (weightSecond >= weightFirst) {
    weightSecond = Math.max(1000, weightFirst - randomInt(500, 8000))
  }
  const weightGap = weightFirst - weightSecond
  const slipNum = randomInt(1, 99999)
  const times = randomTimePair()

  return {
    num: 900000 + index,
    business,
    car,
    product,
    area,
    ...times,
    weightFirst,
    weightSecond,
    weightGap,
    inOut,
    unit: 0,
    sumMoney: 0,
    slipNum,
    cardKeyId: randomInt(10000, 99999),
    userName: '',
    carName: '',
    note: '',
    chargeFlag: 'N',
    chargeMoney: 0,
    countReWrite: 0,
    generated: true,
    sourceFile: WEIGHING_PROFILE.sourceFile,
  }
}

export function sourceToRequest(source: WeighingSourcePayload): WeighingRequestPayload {
  return {
    ticketId: `SLIP-${source.slipNum}-${source.num}`,
    vehicleNo: String(source.car),
    grossWeightKg: source.weightFirst,
    tareWeightKg: source.weightSecond,
    source,
  }
}

export function generateWeighingRequest(index: number): WeighingRequestPayload {
  return sourceToRequest(buildSource(Math.max(1, index)))
}

export function generateWeighingItems(
  count: number,
  startIndex = 1,
): WeighingRequestPayload[] {
  return Array.from({ length: count }, (_, index) =>
    generateWeighingRequest(startIndex + index),
  )
}

export function generateWeighingPayload(count: number): GeneratedWeighingPayload {
  const items = generateWeighingItems(count)

  return {
    generatedAt: new Date().toISOString(),
    profile: WEIGHING_PROFILE_NAME,
    count,
    items,
  }
}

export function buildComparison(
  generated: GeneratedWeighingPayload,
  response: CreateWeighingResponse | BulkWeighingResponse | { responses?: Array<{ body: CreateWeighingResponse }> },
): ComparisonPayload {
  const sentItems = generated.items
  let storedItems: WeighingRecord[] = []

  if ('item' in response) {
    storedItems = [response.item]
  } else if ('items' in response && Array.isArray(response.items)) {
    storedItems = response.items
  } else if ('responses' in response && Array.isArray(response.responses)) {
    storedItems = response.responses
      .map((entry) => entry.body?.item)
      .filter((item): item is WeighingRecord => Boolean(item))
  }

  const rows: ComparisonRow[] = sentItems.map((sent, index) => {
    const stored = storedItems[index] ?? null
    const matched =
      Boolean(stored) &&
      sent.ticketId === stored?.ticketId &&
      sent.grossWeightKg === stored?.grossWeightKg &&
      sent.tareWeightKg === stored?.tareWeightKg

    return { index, sent, stored, matched }
  })

  return {
    generatedAt: generated.generatedAt,
    sentCount: sentItems.length,
    storedCount: storedItems.length,
    matchedCount: rows.filter((row) => row.matched).length,
    rows,
  }
}

export function downloadJson(filename: string, payload: unknown) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json;charset=utf-8',
  })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}
