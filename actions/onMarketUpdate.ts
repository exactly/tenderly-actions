import { noCase } from 'no-case';
import { Network } from '@tenderly/actions';
import { WebClient } from '@slack/web-api';
import { Interface } from '@ethersproject/abi';
import { AddressZero } from '@ethersproject/constants';
import { StaticJsonRpcProvider } from '@ethersproject/providers';
import type { BigNumber } from '@ethersproject/bignumber';
import type { LogDescription } from '@ethersproject/abi';
import type { ActionFn, TransactionEvent } from '@tenderly/actions';
import type { MarketInterface, MarketUpdateEventObject } from './types/Market';
import type { Previewer, PreviewerInterface } from './types/Previewer';
import formatMaturity from './utils/formatMaturity';
import formatBigInt from './utils/formatBigInt';
import getSecret from './utils/getSecret';
import multicall from './utils/multicall';
import getIcons from './utils/getIcons';
import previewerABI from './abi/Previewer.json';
import marketABI from './abi/Market.json';

const WAD = 10n ** 18n;

const market = new Interface(marketABI) as MarketInterface;
const previewer = new Interface(previewerABI) as PreviewerInterface;

export default (async ({ storage, secrets, gateways }, {
  network: chainId, blockNumber, hash, from, logs, gasUsed, gasPrice,
}: TransactionEvent) => {
  const network = { 5: Network.GOERLI, 10: 'optimism' }[chainId] ?? Network.MAINNET;
  const etherscan = {
    5: 'https://goerli.etherscan.io',
    10: 'https://optimistic.etherscan.io',
  }[chainId] ?? 'https://etherscan.io';

  const warmup = Promise.all([
    import(`@exactly-protocol/protocol/deployments/${network}/Previewer.json`)
      .then(async ({ address }: { address: string }) => {
        const rpc = Object.values<string>(Network).includes(network)
          ? gateways.getGateway(network as Network)
          : await secrets.get(`RPC_${chainId}`);
        const provider = new StaticJsonRpcProvider(rpc);
        const mainnetProvider = Number(chainId) === 1
          ? provider
          : new StaticJsonRpcProvider(gateways.getGateway(Network.MAINNET));
        const [[, [tsData, exactlyData]], name] = await Promise.all([
          multicall.connect(provider).callStatic.aggregate([
            { target: multicall.address, callData: multicall.interface.encodeFunctionData('getCurrentBlockTimestamp') },
            { target: address, callData: previewer.encodeFunctionData('exactly', [AddressZero]) },
          ], { blockTag: blockNumber }),
          mainnetProvider.lookupAddress(from.substring(2)),
        ]);
        const [ts] = multicall.interface.decodeFunctionResult('getCurrentBlockTimestamp', tsData) as [BigNumber];
        const [exactly] = previewer.decodeFunctionResult('exactly', exactlyData) as [Previewer.MarketAccountStructOutput[]];
        return Promise.all([
          ts, name, exactly, getIcons(secrets, exactly.map(({ assetSymbol }) => assetSymbol)),
        ]);
      }),

    getSecret(secrets, 'SLACK_TOKEN').then((token) => new WebClient(token)),
    getSecret(secrets, `SLACK_MONITORING@${chainId}`),
    getSecret(secrets, `SLACK_WHALE_ALERT@${chainId}`),
  ]);

  const parallel: Promise<unknown>[] = [warmup];

  for (const { address, data, topics } of logs) {
    let log: LogDescription;
    try { log = market.parseLog({ data, topics }); } catch { continue; }

    if (log.name === 'MarketUpdate') {
      const {
        floatingAssets, floatingDepositShares,
      } = log.args as unknown as MarketUpdateEventObject;
      const shareValue = (floatingAssets.toBigInt() * WAD) / floatingDepositShares.toBigInt();
      const key = `${chainId}:${address}:shareValue`;
      if (shareValue < await storage.getBigInt(key)) throw new Error(`${key} decreased`);
      await storage.putBigInt(key, shareValue);

      parallel.push(warmup.then(([[ts, , exactly, icons], slack, monitoring]) => {
        if (!monitoring) return null;
        const { assetSymbol: symbol, fixedPools } = exactly
          .find(({ market: m }) => m.toLowerCase() === address.toLowerCase())!;

        const arbs = fixedPools.map(({ maturity, depositRate, minBorrowRate }) => (
          depositRate.gt(minBorrowRate) ? [
            formatMaturity(maturity),
            formatBigInt(depositRate, '%'),
            formatBigInt(minBorrowRate, '%'),
          ] : null
        )).filter(Boolean) as [string, string, string][];

        return arbs.length ? slack.chat.postMessage({
          channel: monitoring,
          attachments: [{
            color: '#2da44e',
            title: `${symbol} arb @ ${arbs.map(([maturity]) => maturity).join(' & ')}`,
            fields: arbs.flatMap(([maturity, depositRate, borrowRate]) => [
              { short: true, title: `deposit@${maturity}`, value: depositRate },
              { short: true, title: `borrow@${maturity}`, value: borrowRate },
            ]),
            footer_icon: icons[symbol],
            footer: network,
            ts: ts.toString(),
          }],
        }) : null;
      }));
    }

    if (!log.args.assets) continue;

    parallel.push(warmup.then(([[ts, name, exactly, icons], slack, , whaleAlert]) => {
      if (!whaleAlert) return null;
      const { assetSymbol, decimals } = exactly
        .find(({ market: m }) => m.toLowerCase() === address.toLowerCase())!;

      return slack.chat.postMessage({
        channel: whaleAlert,
        attachments: [{
          color: '#3178c6',
          title: `${formatBigInt(String(log.args.assets), assetSymbol, decimals)} ${noCase(log.name)}`,
          title_link: `${etherscan}/tx/${hash}`,
          author_link: `${etherscan}/address/${from}`,
          author_name: name || `${from.slice(0, 6)}…${from.slice(-4)}`,
          fields: [
            { short: true, title: 'gas price', value: formatBigInt(gasPrice, 'gwei') },
            { short: true, title: 'gas used', value: BigInt(gasUsed).toLocaleString() },
            { short: true, title: 'tx cost', value: formatBigInt(BigInt(gasUsed) * BigInt(gasPrice), 'Ξ') },
            ...'maturity' in log.args
              ? [{ title: 'maturity', value: formatMaturity(log.args.maturity as BigNumber), short: true }] : [],
          ],
          footer_icon: icons[assetSymbol],
          footer: network,
          ts: ts.toString(),
        }],
      });
    }));
  }

  await Promise.all(parallel);
}) as ActionFn;
