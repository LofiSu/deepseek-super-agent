import {
  Domain,
  EventDispatcher,
  LoggerLevel,
  WSClient,
} from '@larksuiteoapi/node-sdk'

export interface FeishuWsListenerOptions {
  appId: string
  appSecret: string
  baseUrl: string
}

export interface FeishuWsListener {
  start(onEvent: (payload: unknown) => void): Promise<void>
  stop(): void
}

function domainFromBaseUrl(baseUrl: string): Domain {
  return baseUrl.includes('larksuite.com') ? Domain.Lark : Domain.Feishu
}

/** Outbound Feishu long-connection listener (official SDK WS client only). */
export class FeishuSdkWsListener implements FeishuWsListener {
  private ws?: WSClient

  constructor(private readonly options: FeishuWsListenerOptions) {}

  async start(onEvent: (payload: unknown) => void): Promise<void> {
    const dispatcher = new EventDispatcher({}).register({
      'im.message.receive_v1': async (data: unknown) => {
        onEvent(data)
      },
    })
    this.ws = new WSClient({
      appId: this.options.appId,
      appSecret: this.options.appSecret,
      domain: domainFromBaseUrl(this.options.baseUrl),
      loggerLevel: LoggerLevel.error,
    })
    await this.ws.start({ eventDispatcher: dispatcher })
  }

  stop(): void {
    this.ws?.close({ force: true })
    this.ws = undefined
  }
}

/** In-memory listener for offline tests (no socket). */
export class FeishuMockWsListener implements FeishuWsListener {
  private handler?: (payload: unknown) => void
  private stopped = false

  async start(onEvent: (payload: unknown) => void): Promise<void> {
    if (this.stopped) throw new Error('mock listener already stopped')
    this.handler = onEvent
  }

  emit(payload: unknown): void {
    this.handler?.(payload)
  }

  stop(): void {
    this.stopped = true
    this.handler = undefined
  }
}
