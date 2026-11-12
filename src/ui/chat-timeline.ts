/**
 * 把消息、确认卡和工具轨迹按时间排进同一条会话。
 * 对得上某条消息 runId 的工具轨迹仍跟在那条消息后面，不单独占位。
 */

export type TimelineKind = 'message' | 'proposal' | 'code' | 'tools' | 'plan' | 'clarify'

export type TimelineSlot = {
  kind: TimelineKind
  id: string
  at: number
}

const KIND_ORDER: Record<TimelineKind, number> = {
  message: 0,
  tools: 1,
  code: 2,
  proposal: 3,
  clarify: 4,
  plan: 5,
}

export function buildChatTimeline(input: {
  messages: Array<{ id: string; createdAt: number; runId?: string }>
  proposals: Array<{ id: string; createdAt: number }>
  codeActions: Array<{ id: string; createdAt: number }>
  plans: Array<{ id: string; createdAt: number }>
  clarifies: Array<{ id: string; createdAt: number }>
  toolEvents: Array<{ id: string; createdAt: number; runId?: string }>
}): TimelineSlot[] {
  const messageRunIds = new Set(input.messages.map((item) => item.runId).filter((id): id is string => Boolean(id)))
  const slots: TimelineSlot[] = [
    ...input.messages.map((item) => ({ kind: 'message' as const, id: item.id, at: item.createdAt })),
    ...input.proposals.map((item) => ({ kind: 'proposal' as const, id: item.id, at: item.createdAt })),
    ...input.codeActions.map((item) => ({ kind: 'code' as const, id: item.id, at: item.createdAt })),
    ...input.plans.map((item) => ({ kind: 'plan' as const, id: item.id, at: item.createdAt })),
    ...input.clarifies.map((item) => ({ kind: 'clarify' as const, id: item.id, at: item.createdAt })),
  ]
  const loose = new Map<string, number>()
  for (const event of input.toolEvents) {
    const key = event.runId && messageRunIds.has(event.runId) ? '' : event.runId || '__orphan__'
    if (!key) continue
    const at = loose.get(key)
    if (at === undefined || event.createdAt < at) loose.set(key, event.createdAt)
  }
  for (const [key, at] of loose) {
    slots.push({ kind: 'tools', id: `tools:${key}`, at })
  }
  slots.sort((a, b) => a.at - b.at || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.id.localeCompare(b.id))
  return slots
}
