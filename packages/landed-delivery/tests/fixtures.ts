import { MemorySource, SHARED_SLOTS, createParamReader, versionHash } from '@osw/core';
import { approvedDelivery, deliveryFixture } from '../../../scripts/gen-delivery-example.mjs';
import { slots } from '../src/slots.js';
export { approvedDelivery, deliveryFixture };
export async function rebuild(fixture: Awaited<ReturnType<typeof deliveryFixture>>) {
  for (const record of fixture.records) record.versionHash = await versionHash(record.data);
  for (const line of fixture.input.bom.body.lines)
    for (const key of ['productRef', 'offerRef'] as const) {
      const record = fixture.records.find(
        (record) => record.slot === line[key]?.slot && record.id === line[key]?.id,
      );
      if (record && line[key]) line[key]!.versionHash = record.versionHash;
    }
  fixture.input.bom.hash = await versionHash(fixture.input.bom.body);
  fixture.source = new MemorySource(fixture.records, [...SHARED_SLOTS, ...slots]);
  fixture.ctx.assets = fixture.source;
  fixture.ctx.params = createParamReader(
    fixture.records.filter((record) => record.slot === 'params'),
    fixture.ctx.now,
    { jurisdiction: 'XE' },
  );
  return fixture;
}
