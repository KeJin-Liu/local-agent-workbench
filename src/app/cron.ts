/**
 * 五段 cron（分 时 日 月 周）的解析与匹配。
 * 支持 *、a、a-b、a,b、* / n、a-b/n；周 0/7 都算周日。
 * 任务调度和页面「下次运行」共用这一套，避免两处语义不一致。
 */

export type CronSchedule = {
  minutes: Set<number>
  hours: Set<number>
  daysOfMonth: Set<number>
  months: Set<number>
  daysOfWeek: Set<number>
  domRestricted: boolean
  dowRestricted: boolean
}

const FIELD_LABELS = ['分钟', '小时', '日', '月', '周'] as const
const FIELD_RANGES: Array<[number, number]> = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
]

/** 解析失败会抛 Error，文案直接给人看。 */
export function parseCron(expression: string): CronSchedule {
  const parts = expression.trim().split(/\s+/).filter(Boolean)
  if (parts.length !== 5) throw new Error('Cron 需要 5 段：分 时 日 月 周')
  const [minutes, hours, daysOfMonth, months, daysOfWeek] = FIELD_RANGES.map(([min, max], index) =>
    parseField(parts[index] ?? '', min, max, FIELD_LABELS[index] ?? '字段'),
  )
  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek: normalizeWeekdays(daysOfWeek),
    domRestricted: isRestricted(parts[2] ?? '*'),
    dowRestricted: isRestricted(parts[4] ?? '*'),
  }
}

/** 按本机时区判断某个时刻是否命中。 */
export function cronMatches(schedule: string | CronSchedule, date: Date): boolean {
  const parsed = typeof schedule === 'string' ? parseCron(schedule) : schedule
  if (!parsed.minutes.has(date.getMinutes())) return false
  if (!parsed.hours.has(date.getHours())) return false
  if (!parsed.months.has(date.getMonth() + 1)) return false
  const domMatch = parsed.daysOfMonth.has(date.getDate())
  const dowMatch = parsed.daysOfWeek.has(date.getDay())
  // Vixie cron：日和周都限制时，任一命中即可。
  if (parsed.domRestricted && parsed.dowRestricted) return domMatch || dowMatch
  if (parsed.domRestricted) return domMatch
  if (parsed.dowRestricted) return dowMatch
  return true
}

const nextCache = new Map<string, { minute: number; at: number | null }>()

/** 下一次命中的时刻；找不到（一年内）返回 null。结果按分钟缓存，页面重复渲染不反复扫。 */
export function nextCronTime(expression: string, from: Date = new Date()): Date | null {
  const cacheKey = Math.floor(from.getTime() / 60_000)
  const cached = nextCache.get(expression)
  if (cached && cached.minute === cacheKey) return cached.at == null ? null : new Date(cached.at)
  const schedule = parseCron(expression)
  const cursor = new Date(from.getTime())
  cursor.setSeconds(0, 0)
  cursor.setMinutes(cursor.getMinutes() + 1)
  let found: Date | null = null
  for (let step = 0; step < 366 * 24 * 60; step += 1) {
    if (cronMatches(schedule, cursor)) {
      found = new Date(cursor.getTime())
      break
    }
    cursor.setMinutes(cursor.getMinutes() + 1)
  }
  nextCache.set(expression, { minute: cacheKey, at: found ? found.getTime() : null })
  if (nextCache.size > 100) {
    const oldest = nextCache.keys().next().value
    if (oldest !== undefined) nextCache.delete(oldest)
  }
  return found
}

function parseField(raw: string, min: number, max: number, label: string): Set<number> {
  if (!raw.trim()) throw new Error(`${label}不能为空`)
  const values = new Set<number>()
  for (const token of raw.split(',')) {
    const part = token.trim()
    if (!part) throw new Error(`${label}有空的取值`)
    for (const value of parseToken(part, min, max, label)) values.add(value)
  }
  if (values.size === 0) throw new Error(`${label}没有有效取值`)
  return values
}

function parseToken(token: string, min: number, max: number, label: string): number[] {
  const [base, stepRaw, extra] = token.split('/')
  if (extra !== undefined) throw new Error(`${label}里的「${token}」格式不对`)
  let step = 1
  if (stepRaw !== undefined) {
    step = Number(stepRaw)
    if (!Number.isInteger(step) || step <= 0) throw new Error(`${label}的步长必须是正整数`)
  }
  let start: number
  let end: number
  if (base === '*' || base === '?') {
    start = min
    end = max
  } else if (base.includes('-')) {
    const [fromRaw, toRaw, more] = base.split('-')
    if (more !== undefined) throw new Error(`${label}里的「${token}」格式不对`)
    start = parseNumber(fromRaw, min, max, label)
    end = parseNumber(toRaw, min, max, label)
    if (start > end) throw new Error(`${label}的范围「${token}」起点大于终点`)
  } else {
    start = parseNumber(base, min, max, label)
    end = stepRaw !== undefined ? max : start
  }
  const values: number[] = []
  for (let value = start; value <= end; value += step) values.push(value)
  return values
}

function parseNumber(raw: string | undefined, min: number, max: number, label: string): number {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label}要在 ${min}–${max} 之间`)
  }
  return value
}

function isRestricted(raw: string): boolean {
  const value = raw.trim()
  return value !== '*' && value !== '?'
}

function normalizeWeekdays(values: Set<number>): Set<number> {
  if (!values.has(7)) return values
  const normalized = new Set(values)
  normalized.delete(7)
  normalized.add(0)
  return normalized
}
