import {
  OfferSlot,
  PartySlot,
  ProductSlot,
  type StepDef,
  StoreSegment,
  SupplierMatch,
  isWithin,
  z,
} from '@osw/core';
import { blocked, queryAll, result } from './helpers.js';
const Input = z.object({ segments: z.array(StoreSegment) });
const Output = z.array(SupplierMatch);
export const matchSuppliers: StepDef<typeof Input, typeof Output> = {
  id: 'replenishment/matchSuppliers',
  input: Input,
  output: Output,
  reads: ['party', 'offer', 'product'],
  params: [],
  async run(input, ctx) {
    const parties = await queryAll(ctx.assets, PartySlot, {
      all: [
        { field: 'roles', op: 'hasAny', value: ['supplier'] },
        { field: 'status', op: 'eq', value: 'active' },
      ],
    });
    if (parties.some((r) => r.redacted?.length))
      return blocked([
        {
          kind: 'asset',
          slot: 'party',
          filter: null,
          reason: 'Supplier matching requires unredacted service fields',
          blocking: true,
        },
      ]);
    const matches: z.infer<typeof Output> = [];
    for (const party of parties) {
      const offers = (
        await queryAll(ctx.assets, OfferSlot, {
          all: [
            { field: 'partyId', op: 'eq', value: party.id },
            { field: 'use', op: 'eq', value: 'repeat' },
          ],
        })
      ).filter(
        (r) =>
          (!r.data.validUntil || r.data.validUntil >= ctx.now.slice(0, 10)) &&
          (!r.data.validFrom || r.data.validFrom <= ctx.now.slice(0, 10)),
      );
      const productIds = [
        ...new Set(offers.flatMap((r) => (r.data.productId ? [r.data.productId] : []))),
      ];
      const products = [];
      for (let i = 0; i < productIds.length; i += 200)
        products.push(
          ...(await queryAll(ctx.assets, ProductSlot, {
            field: 'id',
            op: 'in',
            value: productIds.slice(i, i + 200),
          })),
        );
      if (offers.some((r) => r.redacted?.length) || products.some((r) => r.redacted?.length))
        return blocked([
          {
            kind: 'asset',
            slot: 'offer',
            filter: null,
            reason: 'Supplier matching requires unredacted offer and product fields',
            blocking: true,
          },
        ]);
      const byId = new Map(
        products.filter((p) => p.data.status === 'active').map((p) => [p.id, p]),
      );
      const match: z.infer<typeof SupplierMatch> = {
        supplierId: party.id,
        offerIds: [],
        segments: [],
        blocked: { region: 0, cats: 0, track: 0 },
      };
      for (const segment of input.segments) {
        if (!(party.data.jurisdictions ?? []).some((prefix) => isWithin(segment.region, prefix))) {
          match.blocked.region += segment.count;
          continue;
        }
        const sharedCats = segment.supplyCats.filter((cat) =>
          party.data.profiles?.supplier?.supplyCats.includes(cat),
        );
        const applicable = offers.filter(
          (offer) =>
            offer.data.productId &&
            sharedCats.includes(byId.get(offer.data.productId)?.data.category ?? ''),
        );
        if (!sharedCats.length || !applicable.length) {
          match.blocked.cats += segment.count;
          continue;
        }
        if (party.data.tracks?.length && !party.data.tracks.includes(segment.track)) {
          match.blocked.track += segment.count;
          continue;
        }
        match.segments.push({
          key: segment.key,
          count: segment.count,
          sharedCats: [...sharedCats].sort(),
        });
        match.offerIds.push(...applicable.map((r) => r.id));
      }
      match.segments.sort(
        (a, b) => b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
      );
      match.offerIds = [...new Set(match.offerIds)].sort();
      matches.push(match);
    }
    return result(matches);
  },
};
