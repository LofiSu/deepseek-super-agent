import { describe, expect, it } from 'vitest'
import type { OutboundMessage, ReplyKind } from '../shared/types.js'
import { CliChannel, FakeGithubChannel, FakeImChannel, MemoryOutbox } from './index.js'

const kinds: ReplyKind[] = ['acknowledgement', 'answer', 'result', 'attention']

function message(kind: ReplyKind, source: string, thread: string, address: Record<string, string>): OutboundMessage {
  return {
    id: `${source}-${kind}`,
    channel: { source, thread, address },
    text: `${kind} text`,
    kind,
    ticketId: 'k1',
  }
}

describe('channel adapters', () => {
  it('formats the four reply kinds on the CLI', () => {
    const cli = new CliChannel()
    for (const kind of kinds) cli.deliver(message(kind, 'cli', 'cli', { stream: 'stdout' }))
    expect(cli.outbound).toEqual([
      'acknowledgement ticket=k1: acknowledgement text',
      'answer ticket=k1: answer text',
      'result ticket=k1: result text',
      'attention ticket=k1: attention text',
    ])
    expect(cli.receive('hello').threadId).toBe('cli')
  })

  it('keeps a fake IM room and a fake GitHub issue in memory', () => {
    const im = new FakeImChannel()
    const inbound = im.post('room-1', 'ada', 'please look')
    expect(inbound).toMatchObject({ source: 'im', threadId: 'room-1', human: true, address: { room: 'room-1' } })
    im.deliver(message('answer', 'im', 'room-1', { room: 'room-1' }))
    expect(im.rooms.get('room-1')?.map(line => line.text)).toEqual([
      'please look',
      'answer ticket=k1: answer text',
    ])

    const github = new FakeGithubChannel()
    github.open(7, 'build failed')
    expect(github.comment(7, 'ada', 'rerun ci')).toMatchObject({ source: 'github', threadId: '7', human: true })
    github.deliver(message('result', 'github', '7', { issue: '7' }))
    expect(github.issues.get(7)?.comments.at(-1)).toMatchObject({ kind: 'result', user: 'ds-agent' })
    expect(() => github.deliver(message('result', 'github', '99', { issue: '99' }))).toThrow(/not found/)
  })
})

describe('outbox', () => {
  it('sends once, withdraws pending mail, and flushes the rest', () => {
    const cli = new CliChannel()
    const im = new FakeImChannel()
    const outbox = new MemoryOutbox([cli, im, new FakeGithubChannel()])
    const ack = message('acknowledgement', 'cli', 'cli', { stream: 'stdout' })
    const answer = message('answer', 'im', 'room-1', { room: 'room-1' })
    outbox.send(ack)
    outbox.send(ack)
    outbox.send(answer)
    expect(outbox.status(ack.id)).toBe('pending')
    outbox.withdraw(answer.id)
    outbox.flush()
    expect(outbox.status(ack.id)).toBe('sent')
    expect(outbox.status(answer.id)).toBe('dropped')
    expect(cli.outbound).toEqual(['acknowledgement ticket=k1: acknowledgement text'])
    expect(im.rooms.size).toBe(0)
    expect(() => outbox.send({ ...ack, id: 'bad', kind: 'nope' as ReplyKind })).toThrow(/reply kind/)
    expect(() => outbox.send({ ...ack, id: 'missing', channel: { ...ack.channel, source: 'feishu' } })).toThrow(/no adapter/)
  })
})
