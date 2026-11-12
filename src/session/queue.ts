/**
 * 内存里的回合队列。下一步发送时会先查 runs 的幂等键，再决定要不要入队。
 */

export type TurnInput = {
  id: string
  conversationId: string
  idempotencyKey: string
}

export type QueuedTurn = TurnInput & { enqueuedAt: number }

export type EnqueueResult = { accepted: true } | { accepted: false; reason: 'duplicate' }

/** 同一进程内拒绝重复的 idempotencyKey。重启后以 runs 表为准。 */
export class TurnQueue {
  private readonly items: QueuedTurn[] = []

  /** @param turn 待发送的回合 */
  enqueue(turn: TurnInput): EnqueueResult {
    if (this.items.some((item) => item.idempotencyKey === turn.idempotencyKey)) {
      return { accepted: false, reason: 'duplicate' }
    }
    this.items.push({ ...turn, enqueuedAt: Date.now() })
    return { accepted: true }
  }

  /** 当前队列的副本。 */
  snapshot(): readonly QueuedTurn[] {
    return this.items.slice()
  }
}

/** 会话 id 加客户端回合 id，组成 runs 表上的唯一键。 */
export function buildIdempotencyKey(conversationId: string, clientTurnId: string): string {
  return `${conversationId}:${clientTurnId}`
}
