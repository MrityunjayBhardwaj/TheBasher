// Test-only node types. Mirror the shape of real nodes but stay tiny so
// tests don't depend on the real registry from src/nodes/**.
import { z } from 'zod';
import { __resetRegistryForTests, registerNodeType } from '../registry';

export function seedTestRegistry(): void {
  __resetRegistryForTests();

  registerNodeType<{ value: number }, number>({
    type: 'TestNumber',
    version: 1,
    pure: true,
    cost: 'cheap',
    paramSchema: z.object({ value: z.number() }),
    inputs: {},
    outputs: { out: { type: 'Number', cardinality: 'single' } },
    evaluate: (params) => params.value,
  });

  registerNodeType<Record<string, unknown>, number>({
    type: 'TestSum',
    version: 1,
    pure: true,
    cost: 'cheap',
    paramSchema: z.object({}).passthrough(),
    inputs: {
      a: { type: 'Number', cardinality: 'single' },
      b: { type: 'Number', cardinality: 'single' },
    },
    outputs: { out: { type: 'Number', cardinality: 'single' } },
    evaluate: (_params, inputs) => {
      const a = (inputs.a as number) ?? 0;
      const b = (inputs.b as number) ?? 0;
      return a + b;
    },
  });

  registerNodeType<Record<string, unknown>, number>({
    type: 'TestSumList',
    version: 1,
    pure: true,
    cost: 'cheap',
    paramSchema: z.object({}).passthrough(),
    inputs: { items: { type: 'Number', cardinality: 'list' } },
    outputs: { out: { type: 'Number', cardinality: 'single' } },
    evaluate: (_params, inputs) => {
      const items = (inputs.items as number[]) ?? [];
      return items.reduce((acc, v) => acc + v, 0);
    },
  });

  let counter = 0;
  registerNodeType<Record<string, unknown>, number>({
    type: 'TestImpureCounter',
    version: 1,
    pure: false,
    cost: 'cheap',
    paramSchema: z.object({}).passthrough(),
    inputs: {},
    outputs: { out: { type: 'Number', cardinality: 'single' } },
    evaluate: () => ++counter,
  });
}
