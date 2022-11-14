import { Interface } from '@ethersproject/abi';
import type { ActionFn, TransactionEvent } from '@tenderly/actions';
import type { MarketUpdateEventObject } from './types/Market';
import MarketABI from './abi/Market.json';

const WAD = 10n ** 18n;

const decoder = new Interface(MarketABI);

export default (async ({ storage }, { network, logs }: TransactionEvent) => {
  for (const { address, data, topics } of logs) {
    let shareValue: bigint;
    try {
      const {
        floatingAssets,
        floatingDepositShares,
      } = decoder.decodeEventLog('MarketUpdate', data, topics) as unknown as MarketUpdateEventObject;

      shareValue = (floatingAssets.toBigInt() * WAD) / floatingDepositShares.toBigInt();
    } catch { continue; }

    const key = `${network}:${address}:shareValue`;
    if (shareValue < await storage.getBigInt(key)) throw new Error(`${key} decreased`);

    await storage.putBigInt(key, shareValue);
  }
}) as ActionFn;
