import { distanceKm } from '../rules/common.js';
import { Listing, type ListingData } from '../slots/listing.js';
import type { ListingFeed } from './types.js';
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const input = text.replace(/^# example: synthetic\r?\n/, '').replace(/^\uFEFF/, '');
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (c === '"') {
      if (quoted && input[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && (c === ',' || c === '\n')) {
      row.push(field.replace(/\r$/, ''));
      field = '';
      if (c === '\n') {
        if (row.some(Boolean)) rows.push(row);
        row = [];
      }
    } else field += c;
  }
  if (quoted) throw new Error('Unterminated CSV quote');
  if (field || row.length) {
    row.push(field.replace(/\r$/, ''));
    rows.push(row);
  }
  const headers = rows.shift() ?? [];
  if (new Set(headers).size !== headers.length) throw new Error('Duplicate CSV headers');
  return rows.map((values) => {
    if (values.length !== headers.length) throw new Error('CSV column mismatch');
    return Object.fromEntries(headers.map((h, i) => [h, values[i]!]));
  });
}
// 列映射由宿主显式提供，未知值不得用猜测填成已知。
export function csvListingFeed(
  csv: string,
  map: (row: Record<string, string>) => ListingData,
): ListingFeed {
  const listings = parseCsv(csv).map((row) => Listing.parse(map(row)));
  return {
    name: 'csv',
    async search(input) {
      return listings
        .filter(
          (l) =>
            l.status === 'active' &&
            (l.jurisdiction === input.jurisdiction ||
              l.jurisdiction.startsWith(`${input.jurisdiction}-`)) &&
            l.geo &&
            distanceKm(l.geo, input.center) <= input.radiusKm,
        )
        .slice(0, input.limit);
    },
  };
}
