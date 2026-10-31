export class AgentError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'AgentError'
    this.code = code
  }
}

export class FilteredError extends AgentError {
  constructor(message = 'trigger filtered') {
    super('filtered', message)
    this.name = 'FilteredError'
  }
}

export class DuplicateError extends AgentError {
  constructor(message = 'trigger duplicate') {
    super('duplicate', message)
    this.name = 'DuplicateError'
  }
}
