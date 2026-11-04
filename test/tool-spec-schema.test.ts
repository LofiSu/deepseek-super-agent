import { expect, it } from 'vitest'
import type { ToolSpec } from '../src/harness/model.ts'

it('accepts full JSON Schema tool parameters', () => {
  const spec: ToolSpec = {
    name: 'example',
    description: 'array and enum',
    parameters: {
      type: 'object',
      properties: {
        refs: { type: 'array', items: { type: 'string' }, minItems: 1 },
        model: { type: 'string', enum: ['a', 'b'] },
      },
      required: ['refs'],
      additionalProperties: false,
    },
  }
  expect((spec.parameters.properties?.refs as { items: { type: string } }).items.type).toBe('string')
})
