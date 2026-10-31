/** Caller-facing failure. Engine commands throw this for invalid requests. */
export class UserError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UserError'
  }
}
