import type { BuildPlanBody, z } from '@osw/core';
import type { BuildOutInput } from '../models.js';

export function projectClientQuote(
  quote: z.infer<typeof BuildPlanBody>['quote'],
  input: Pick<BuildOutInput, 'bom'>,
) {
  return {
    currency: quote.currency,
    lines: quote.lines.map((line) => {
      const parts = input.bom.body.lines.find((b) => b.id === line.bomLineId)?.parts ?? [];
      return {
        id: line.id,
        name: line.name,
        qty: line.qty,
        unitPrice: line.unitPrice,
        laborPerUnit: line.laborPerUnit,
        materials: {
          main: [...new Set(parts.filter((p) => p.kind === 'material').map((p) => p.name))],
          accessories: [...new Set(parts.filter((p) => p.kind === 'hardware').map((p) => p.name))],
        },
      };
    }),
    fees: quote.fees.map(({ id, name, amount }) => ({ id, name, amount })),
    total: quote.totals.total,
    options: quote.options,
  };
}
