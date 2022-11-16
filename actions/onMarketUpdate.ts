import fetch from 'cross-fetch';
import { noCase } from 'no-case';
import { Network } from '@tenderly/actions';
import { Contract } from '@ethersproject/contracts';
import { Interface } from '@ethersproject/abi';
import { StaticJsonRpcProvider } from '@ethersproject/providers';
import type { BigNumber } from '@ethersproject/bignumber';
import type { LogDescription } from '@ethersproject/abi';
import type { ActionFn, TransactionEvent } from '@tenderly/actions';
import type { Market, MarketUpdateEventObject } from './types/Market';
import type { ERC20 } from './types/ERC20';
import formatBigInt from './utils/formatBigInt';
import getSecret from './utils/getSecret';
import marketABI from './abi/Market.json';
import erc20ABI from './abi/ERC20.json';

const WAD = 10n ** 18n;

const decoder = new Interface(marketABI);

export default (async ({ storage, secrets, gateways }, {
  network: chainId, logs, hash, from, blockHash, gasUsed, gasPrice,
}: TransactionEvent) => {
  const whaleAlert = await getSecret(secrets, `SLACK_WHALE_ALERT@${chainId}`);
  const promises: Promise<unknown>[] = [];

  for (const { address, data, topics } of logs) {
    let log: LogDescription;
    try { log = decoder.parseLog({ data, topics }); } catch { continue; }

    if (log.name === 'MarketUpdate') {
      const {
        floatingAssets, floatingDepositShares,
      } = log.args as unknown as MarketUpdateEventObject;
      const shareValue = (floatingAssets.toBigInt() * WAD) / floatingDepositShares.toBigInt();
      const key = `${chainId}:${address}:shareValue`;
      if (shareValue < await storage.getBigInt(key)) throw new Error(`${key} decreased`);
      await storage.putBigInt(key, shareValue);
    }

    const network = { 5: Network.GOERLI }[chainId] ?? Network.MAINNET;
    const etherscan = `https://${network !== Network.MAINNET ? `${network}.` : ''}etherscan.io`;
    const provider = new StaticJsonRpcProvider(gateways.getGateway(network));
    const market = new Contract(address, marketABI, provider) as Market;

    if (!whaleAlert || !log.args.assets) continue;

    promises.push((async () => {
      const asset = new Contract(await market.asset(), erc20ABI, provider) as ERC20;
      const [symbol, decimals, block, ensName] = await Promise.all([
        asset.symbol(),
        asset.decimals(),
        provider.getBlock(blockHash),
        provider.lookupAddress(from),
      ]);
      await fetch(whaleAlert, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          attachments: [{
            title: `${formatBigInt(String(log.args.assets), symbol, decimals)} ${noCase(log.name)}`,
            title_link: `${etherscan}/tx/${hash}`,
            author_link: `${etherscan}/address/${from}`,
            author_name: ensName ?? from,
            footer_icon: await getSecret(secrets, `${symbol}.icon`),
            footer: symbol,
            ts: block.timestamp,
            fields: [
              { short: true, title: 'gas price', value: formatBigInt(gasPrice, 'gwei') },
              { short: true, title: 'gas used', value: BigInt(gasUsed).toLocaleString() },
              { short: true, title: 'tx cost', value: formatBigInt(BigInt(gasUsed) * BigInt(gasPrice), 'Ξ') },
              ...'maturity' in log.args ? [{
                title: 'maturity',
                value: new Date((log.args.maturity as BigNumber).toNumber() * 1_000)
                  .toISOString().slice(0, 10),
                short: true,
              }] : [],
            ],
          }],
        }),
      });
    })());
  }

  await Promise.all(promises);
}) as ActionFn;
