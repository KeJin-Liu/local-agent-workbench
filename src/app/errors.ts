/**
 * 用例层的可预期错误。路由把它变成 JSON，而不是 500。
 */

export class AppError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'AppError'
    this.status = status
  }
}
