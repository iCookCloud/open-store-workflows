import { spawn } from 'node:child_process';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from '../base.js';
import { OswSourceError } from '../errors.js';
import { pathValues } from '../filter.js';
import { canonicalJson } from '../hash.js';
import { AssetRecord } from '../slot.js';
import type { AnyAssetRecord, SlotDef } from '../slot.js';
import { SHARED_SLOTS } from '../slots/index.js';
import { MemorySource } from '../source.js';
import { Fill, Verification } from '../verification.js';
import type { RecordResult } from '../verification.js';
const SAFE_NAME = /^[a-z][a-z0-9-]{0,31}$/;
function parseCsv(text: string): string[][] {
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
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}
function unwrap(schema: z.core.$ZodType): z.core.$ZodType {
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault
  )
    return unwrap(schema.unwrap());
  return schema;
}
function schemaAt(
  schema: z.core.$ZodType | undefined,
  path: string[],
): z.core.$ZodType | undefined {
  if (!schema) return undefined;
  if (!path.length) return unwrap(schema);
  const object = unwrap(schema);
  if (!(object instanceof z.ZodObject)) return undefined;
  return schemaAt(object.shape[path[0]], path.slice(1));
}
function cellValue(value: string, schema: z.core.$ZodType | undefined): unknown {
  if (value === '') return undefined;
  const target = schema ? unwrap(schema) : undefined;
  if (
    target instanceof z.ZodString ||
    target instanceof z.ZodEnum ||
    target instanceof z.ZodLiteral
  )
    return value;
  if (value.startsWith('[') || value.startsWith('{') || value === 'null') return JSON.parse(value);
  if (target instanceof z.ZodArray)
    return value.split(';').map((v) => cellValue(v, target.element));
  if (target instanceof z.ZodBoolean) {
    if (value !== 'true' && value !== 'false') throw new Error('Invalid CSV boolean');
    return value === 'true';
  }
  if (target instanceof z.ZodNumber) {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error('Invalid CSV number');
    return n;
  }
  if (value.includes(';')) return value.split(';');
  if (value === 'true' || value === 'false') return value === 'true';
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}
export function recordsFromCsv(text: string, slot?: SlotDef): AnyAssetRecord[] {
  const schema = AssetRecord(slot?.schema ?? z.unknown());
  const lines = text.replace(/^# example: synthetic\r?\n/, '');
  const [headers, ...rows] = parseCsv(lines);
  if (!headers) return [];
  return rows
    .filter((r) => r.some(Boolean))
    .map((row) => {
      const out: Record<string, unknown> = {};
      headers.forEach((header, i) => {
        const path = header.split('.');
        if (path.some((p) => ['__proto__', 'constructor', 'prototype', ''].includes(p)))
          throw new Error('Invalid CSV column');
        let parent = out;
        for (const p of path.slice(0, -1)) {
          parent[p] ??= {};
          parent = parent[p] as Record<string, unknown>;
        }
        const v = cellValue(row[i] ?? '', schemaAt(schema, path));
        if (v !== undefined) parent[path[path.length - 1]] = v;
      });
      return out as AnyAssetRecord;
    });
}
export class FileSource extends MemorySource {
  private initialized?: Promise<void>;
  private readonly directory: string;
  private readonly definitions: readonly SlotDef[];
  private writing: Promise<unknown> = Promise.resolve();
  constructor(directory: string, slots: readonly SlotDef[] = SHARED_SLOTS) {
    super([], slots);
    this.directory = directory;
    this.definitions = slots;
  }
  static async open(
    directory: string,
    slots: readonly SlotDef[] = SHARED_SLOTS,
  ): Promise<FileSource> {
    const source = new FileSource(directory, slots);
    await source.ready();
    return source;
  }
  protected override async ready(): Promise<void> {
    this.initialized ??= this.load();
    await this.initialized;
  }
  private async load(): Promise<void> {
    const records = new Map<string, AnyAssetRecord>();
    const verifications: Verification[] = [];
    const fills: Fill[] = [];
    for (const slot of this.definitions) {
      if (!SAFE_NAME.test(slot.name)) throw new Error('Invalid slot name');
      let found = false;
      for (const extension of ['json', 'ndjson', 'csv']) {
        const text = await readOptional(join(this.directory, `${slot.name}.${extension}`));
        if (text === null) continue;
        if (found)
          throw new OswSourceError('invalid_record', `Multiple files for slot ${slot.name}`);
        found = true;
        const rows = parseSlotFile(text, extension, slot);
        for (const record of rows) {
          if (record.slot !== slot.name) throw new Error('Slot file mismatch');
          records.set(`${record.slot}/${record.id}`, record);
        }
      }
    }
    const verificationJournal = await readOptional(join(this.directory, '_verifications.ndjson'));
    if (verificationJournal)
      verifications.push(...parseJournal(verificationJournal).map((v) => Verification.parse(v)));
    const fillJournal = await readOptional(join(this.directory, '_fills.ndjson'));
    const replay = new MemorySource([...records.values()], this.definitions);
    if (fillJournal)
      for (const event of parseJournal(fillJournal)) {
        const batch = (event.fills ?? [event.fill]).map((raw: unknown) => Fill.parse(raw));
        // 只重放被版本守卫接受的单字段补空，禁止用旧整条快照覆盖其它字段集的新内容。
        const outcomes = await replay.applyFills(batch);
        for (const [index, outcome] of outcomes.entries()) {
          const fill = batch[index];
          if (outcome.status !== 'recorded' && outcome.status !== 'duplicate') {
            const current = replay
              .snapshot()
              .find((r) => r.slot === fill.asset.slot && r.id === fill.asset.id);
            const target = fill.field.replace(/^\//, '').replaceAll('/', '.');
            const present = current ? pathValues(current.data, target)[0] : undefined;
            // 资产文件已经包含同一核实值时，日志只是已折叠的历史；其它失败必须显式交给调用者处理。
            if (canonicalJson(present) !== canonicalJson(fill.value)) {
              throw new OswSourceError(
                'journal_conflict',
                `Fill journal conflict: ${fill.asset.slot}/${fill.asset.id}/${fill.field} (${outcome.status})`,
              );
            }
          }
          fills.push(fill);
        }
      }
    this.records = replay.snapshot();
    this.verifications.splice(0, this.verifications.length, ...verifications);
    this.fills.splice(0, this.fills.length, ...fills);
  }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const p = this.writing.then(work);
    this.writing = p.catch(() => {});
    return p;
  }
  private async writeLocked<T>(work: () => Promise<T>): Promise<T> {
    await this.ready();
    return this.serialize(async () => {
      await mkdir(this.directory, { recursive: true });
      return withFileLock(join(this.directory, '.osw-write.lock'), async () => {
        await this.load();
        return work();
      });
    });
  }
  override async recordVerification(vs: readonly Verification[]): Promise<RecordResult[]> {
    return this.writeLocked(async () => {
      const shadow = new MemorySource(this.snapshot(), this.definitions);
      shadow.verifications.push(...this.verifications);
      const results = await shadow.recordVerification(vs);
      const accepted = shadow.verifications.slice(this.verifications.length);
      if (accepted.length)
        await appendFile(
          join(this.directory, '_verifications.ndjson'),
          `${accepted.map((v) => JSON.stringify(v)).join('\n')}\n`,
        );
      this.verifications.push(...accepted);
      return results;
    });
  }
  override async applyFills(fs: readonly Fill[]): Promise<RecordResult[]> {
    return this.writeLocked(async () => {
      const shadow = new MemorySource(this.snapshot(), this.definitions);
      const results = await shadow.applyFills(fs);
      const accepted = fs.filter((_, index) => results[index].status === 'recorded');
      if (accepted.length)
        await appendFile(
          join(this.directory, '_fills.ndjson'),
          `${JSON.stringify({ fills: accepted })}\n`,
        );
      this.records = shadow.snapshot();
      this.fills.push(...shadow.fills);
      return results;
    });
  }
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
function parseJournal(text: string): any[] {
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
function parseSlotFile(text: string, extension: string, slot: SlotDef): AnyAssetRecord[] {
  if (extension === 'csv') return recordsFromCsv(text, slot);
  if (extension === 'ndjson') return parseJournal(text).filter((v) => !v.$example);
  const parsed = JSON.parse(text);
  const records = Array.isArray(parsed) ? parsed : parsed.items;
  if (!Array.isArray(records)) throw new OswSourceError('invalid_record', 'Expected items array');
  return records;
}
// flock 持有内核锁，关闭子进程 stdin 释放锁；锁文件保留，避免删除操作与失效锁判断。
async function withFileLock<T>(path: string, work: () => Promise<T>): Promise<T> {
  const child = spawn(
    'flock',
    [
      '--exclusive',
      '--wait',
      '15',
      path,
      process.execPath,
      '-e',
      "process.stdout.write('locked\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));",
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let output = '';
  let errorText = '';
  child.stderr.on('data', (data) => {
    errorText += String(data);
  });
  const completion = new Promise<void>((resolve, reject) => {
    child.once('error', (error) =>
      reject(
        new OswSourceError(
          'source_unavailable',
          `FileSource writes require flock: ${error.message}`,
        ),
      ),
    );
    child.once('exit', (code) =>
      code === 0
        ? resolve()
        : reject(
            new OswSourceError('source_unavailable', `File lock failed: ${errorText || code}`),
          ),
    );
  });
  // 在锁拿到之前同时监听结束，缺工具或超时必须明确失败。
  const locked = new Promise<void>((resolve) => {
    child.stdout.on('data', (data) => {
      output += String(data);
      if (output.includes('locked')) resolve();
    });
  });
  await Promise.race([
    locked,
    completion.then(() => {
      throw new OswSourceError('source_unavailable', 'File lock exited before acquisition');
    }),
  ]);
  try {
    return await work();
  } finally {
    child.stdin.end();
    await completion;
  }
}
