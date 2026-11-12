/**
 * 好友头像。内置图用定稿里的色块字，上传图仍显示原文件。
 */

import { useState } from 'react'
import type { FriendAvatar } from '../domain/types.ts'

const TILE: Record<string, { label: string; tone: string }> = {
  seal: { label: '印', tone: 'av-seal' },
  crane: { label: '鹤', tone: 'av-crane' },
  pine: { label: '松', tone: 'av-pine' },
  lantern: { label: '灯', tone: 'av-lantern' },
  moon: { label: '月', tone: 'av-moon' },
  brush: { label: '笔', tone: 'av-brush' },
}

/** @param avatar 好友上的头像字段，可以还没有 path */
export function Avatar({
  avatar,
  name,
  size = 'md',
}: {
  avatar?: FriendAvatar
  name: string
  size?: 'sm' | 'md' | 'lg'
}) {
  const [broken, setBroken] = useState(false)
  const sizeClass = size === 'sm' ? 'av-sm' : size === 'lg' ? 'av-lg' : ''
  const tile = avatar?.kind === 'default' && avatar.id ? TILE[avatar.id] : undefined
  if (tile) {
    return (
      <span className={`av ${sizeClass} ${tile.tone}`} aria-hidden="true">
        {tile.label}
      </span>
    )
  }
  const letter = name.trim().slice(0, 1) || '角'
  if (!avatar?.path || broken) {
    return (
      <span className={`av ${sizeClass} av-prod`} aria-hidden="true">
        {letter}
      </span>
    )
  }
  return (
    <img
      className={`av ${sizeClass}`}
      src={avatar.path}
      alt=""
      onError={() => setBroken(true)}
    />
  )
}
