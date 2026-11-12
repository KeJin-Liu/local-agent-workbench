/**
 * 内置头像清单。文件在 src/assets/avatars，页面通过 /avatars/defaults 取图。
 */

export const DEFAULT_AVATAR_CATALOG = [
  { id: 'seal', label: '印' },
  { id: 'crane', label: '鹤' },
  { id: 'pine', label: '松' },
  { id: 'lantern', label: '灯' },
  { id: 'moon', label: '月' },
  { id: 'brush', label: '笔' },
] as const

export type DefaultAvatarId = (typeof DEFAULT_AVATAR_CATALOG)[number]['id']
