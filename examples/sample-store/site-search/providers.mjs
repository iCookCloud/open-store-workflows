import { readFile } from 'node:fs/promises';
import { MemoryQuotaStore, MemoryCacheStore, csvListingFeed, manualEsign } from '@osw/site-search/providers';

// 仅供确定性合成示例；真实宿主应替换这些明确标记的输入。
export async function createProviders({ now }) {
  const load = async (name) => JSON.parse(await readFile(new URL(name, import.meta.url), 'utf8'));
  const receipts = (await load('./receipts.json')).items.map((r) => ({ ...r, signedPdf: Uint8Array.from(r.signedPdf), auditCertificate: Uint8Array.from(r.auditCertificate) }));
  const listing = (await load('./assets/listing.json')).items[0].data;
  const places = (await load('./places.json')).items;
  return {
    providers: {
      places: { name: 'example', persistable: ['providerPlaceId'], maxCacheSeconds: 0, search: async () => structuredClone(places) },
      listingFeed: csvListingFeed('id\nexample-vacancy', () => listing),
      esign: manualEsign(receipts),
    },
    stores: { quota: new MemoryQuotaStore(() => Date.parse(now)), cache: new MemoryCacheStore(() => Date.parse(now)) },
  };
}
