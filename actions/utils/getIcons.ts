import type { Secrets } from '@tenderly/actions';
import getSecret from './getSecret';

export default async (secrets: Secrets, symbols: string[]) => Object
  .fromEntries<string | undefined>(await Promise
  .all(symbols
    .map(async (symbol) => [symbol, await getSecret(secrets, `${symbol}.icon`)] as [string, string | undefined])));
