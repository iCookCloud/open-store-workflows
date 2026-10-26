import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { IsoDateTime } from '../base.js';
import type { RunOptions } from './runner.js';

export type ProviderAdapters = Pick<RunOptions, 'providers' | 'stores'>;

/** 只加载调用者显式选择的本机代码；凭证仍由宿主读取环境变量。 */
export async function loadProviders(path: string, now: string): Promise<ProviderAdapters> {
  IsoDateTime.parse(now);
  const module = await import(pathToFileURL(resolve(path)).href);
  if (typeof module.createProviders !== 'function')
    throw new Error('Provider module must export createProviders({now})');
  const value: unknown = await module.createProviders({ now });
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Provider module must return adapters');
  const adapters = value as ProviderAdapters;
  if (
    adapters.providers !== undefined &&
    (!adapters.providers ||
      typeof adapters.providers !== 'object' ||
      Array.isArray(adapters.providers))
  )
    throw new Error('Invalid provider collection');
  if (
    adapters.stores &&
    (typeof adapters.stores.quota?.consume !== 'function' ||
      typeof adapters.stores.cache?.get !== 'function' ||
      typeof adapters.stores.cache?.put !== 'function')
  )
    throw new Error('Provider stores require quota.consume and cache.get/put');
  return { providers: adapters.providers, stores: adapters.stores };
}
