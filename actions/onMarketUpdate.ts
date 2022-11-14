import fetch from 'cross-fetch';
import { Interface } from '@ethersproject/abi';
import type { ActionFn, TransactionEvent } from '@tenderly/actions';
import type { MarketUpdateEventObject } from './types/Market';
import MarketETHRouterABI from './abi/MarketETHRouter.json';
import MarketABI from './abi/Market.json';

const WAD = 10n ** 18n;

const decoder = (() => {
  const set = new Set();
  return new Interface([...MarketABI, ...MarketETHRouterABI].filter(({ type, name, inputs }) => {
    const key = `${type}:${name ?? ''}:${JSON.stringify(inputs?.map((i) => i.type))}`;
    return !set.has(key) && set.add(key);
  }));
})();

export default (async ({ storage, secrets }, {
  network, logs, input, hash,
}: TransactionEvent) => {
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

  try {
    const { name } = decoder.parseTransaction({ data: input });
    await fetch(await secrets.get(`SLACK_WHALE_ALERT@${network}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        blocks: [
          { type: 'header', text: { type: 'plain_text', text: name } },
          { type: 'section', text: { type: 'plain_text', text: hash } },
        ],
      }),
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'SecretNotFound') return;

    throw error;
  }
}) as ActionFn;
