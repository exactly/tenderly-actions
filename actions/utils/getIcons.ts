import type { Storage } from '@tenderly/actions';

export default async (storage: Storage, symbols: string[]) => Object
  .fromEntries<string | undefined>(await Promise
  .all(symbols
    .map(async (symbol) => [symbol, await storage.getStr(`${symbol}.icon`)] as const)));
