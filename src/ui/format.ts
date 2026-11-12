/** 会话列表上的短时间：刚刚、昨天、周几。 */
export function formatListTime(timestamp: number, now = Date.now()): string {
  const startToday = new Date(now)
  startToday.setHours(0, 0, 0, 0)
  const start = startToday.getTime()
  if (timestamp >= start) {
    if (now - timestamp < 45_000) return '刚刚'
    return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(timestamp)
  }
  if (timestamp >= start - 24 * 60 * 60 * 1000) return '昨天'
  return new Intl.DateTimeFormat('zh-CN', { weekday: 'short' }).format(timestamp)
}

/** 把时间戳收成列表里的短句。 */
export function formatWhen(timestamp: number, now = Date.now()): string {
  const delta = Math.max(0, now - timestamp)
  if (delta < 45_000) return '刚刚'
  if (delta < 60 * 60 * 1000) return `${Math.max(1, Math.floor(delta / 60_000))} 分钟前`
  if (delta < 24 * 60 * 60 * 1000) return `${Math.floor(delta / 3_600_000)} 小时前`
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp)
}

/** 长期记忆时间：Asia/Shanghai 墙上时钟 + 区名。 */
export function formatShanghai(timestamp: number, now = Date.now()): string {
  const zone = 'Asia/Shanghai'
  const startToday = new Date(new Date().toLocaleString('en-US', { timeZone: zone }))
  startToday.setHours(0, 0, 0, 0)
  // Compare calendar days in Shanghai
  const fmtDay = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })
  const today = fmtDay.format(now)
  const that = fmtDay.format(timestamp)
  const time = new Intl.DateTimeFormat('zh-CN', {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(timestamp)
  if (that === today) {
    if (now - timestamp < 45_000) return `刚刚（${zone}）`
    return `今天 ${time}（${zone}）`
  }
  const yesterdayDate = new Date(now - 24 * 60 * 60 * 1000)
  if (fmtDay.format(yesterdayDate) === that) return `昨天 ${time}（${zone}）`
  const date = new Intl.DateTimeFormat('zh-CN', {
    timeZone: zone,
    month: 'numeric',
    day: 'numeric',
  }).format(timestamp)
  return `${date} ${time}（${zone}）`
}
