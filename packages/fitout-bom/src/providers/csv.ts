// CSV 的嵌套字段使用 JSON；支持引号内换行及双引号转义。
export function parseCandidateCsv(text: string): unknown[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === ',' && !quoted) {
      row.push(cell);
      cell = '';
    } else if ((c === '\n' || c === '\r') && !quoted) {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (quoted) throw new Error('Unterminated CSV quote');
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const headers = rows.shift();
  if (!headers?.length || new Set(headers).size !== headers.length)
    throw new Error('CSV needs unique headers');
  return rows
    .filter((r) => r.some(Boolean))
    .map((r) => {
      if (r.length !== headers.length) throw new Error('CSV column count differs from header');
      const output: Record<string, unknown> = {};
      headers.forEach((key, index) => {
        if (['__proto__', 'prototype', 'constructor'].includes(key))
          throw new Error('Unsafe CSV field');
        const value = r[index];
        if (!value) return;
        if (['dimensionsMm', 'componentsHint', 'evidence', 'estimated'].includes(key))
          output[key] = JSON.parse(value);
        else if (key === 'qty') output[key] = Number(value);
        else output[key] = value;
      });
      return output;
    });
}
