import { noCase } from 'no-case';
import { Network } from '@tenderly/actions';
import { namehash } from '@ethersproject/hash';
import { Contract } from '@ethersproject/contracts';
import { WebClient } from '@slack/web-api';
import { Interface } from '@ethersproject/abi';
import { StaticJsonRpcProvider } from '@ethersproject/providers';
import type { BigNumber } from '@ethersproject/bignumber';
import type { LogDescription } from '@ethersproject/abi';
import type { ActionFn, TransactionEvent } from '@tenderly/actions';
import type { Market, MarketInterface, MarketUpdateEventObject } from './types/Market';
import type { Previewer, PreviewerInterface } from './types/Previewer';
import type { ReverseResolverInterface } from './types/ReverseResolver';
import type { ERC20 } from './types/ERC20';
import formatMaturity from './utils/formatMaturity';
import formatBigInt from './utils/formatBigInt';
import getSecret from './utils/getSecret';
import multicall from './utils/multicall';
import previewerABI from './abi/Previewer.json';
import resolverABI from './abi/ReverseResolver.json';
import marketABI from './abi/Market.json';
import erc20ABI from './abi/ERC20.json';

const WAD = 10n ** 18n;
const YEAR = 31_536_000n;

const market = new Interface(marketABI) as MarketInterface;
const resolver = new Interface(resolverABI) as ReverseResolverInterface;
const previewer = new Interface(previewerABI) as PreviewerInterface;

export default (async ({ storage, secrets, gateways }, {
  network: chainId, blockNumber, hash, from, logs, gasUsed, gasPrice,
}: TransactionEvent) => {
  const network = { 5: Network.GOERLI }[chainId] ?? Network.MAINNET;
  const provider = new StaticJsonRpcProvider(gateways.getGateway(network));
  const etherscan = `https://${network !== Network.MAINNET ? `${network}.` : ''}etherscan.io`;

  const warmup = import(`@exactly-protocol/protocol/deployments/${network}/Previewer.json`)
    .then(({ address }: { address: string }) => multicall.connect(provider).callStatic.aggregate([
      { target: multicall.address, callData: multicall.interface.encodeFunctionData('getCurrentBlockTimestamp') },
      {
        target: ({
          [Network.MAINNET]: '0xA2C122BE93b0074270ebeE7f6b7292C7deB45047',
        } as Record<Network, string>)[network] ?? '0x084b1c3C81545d370f3634392De611CaaBFf8148',
        callData: resolver.encodeFunctionData('name', [namehash(`${from.substring(2).toLowerCase()}.addr.reverse`)]),
      },
      { target: address, callData: previewer.encodeFunctionData('previewFixed', [WAD]) },
    ], { blockTag: blockNumber }))
    .then(([, [ts, name, previews]]) => [
      multicall.interface.decodeFunctionResult('getCurrentBlockTimestamp', ts)[0],
      resolver.decodeFunctionResult('name', name)[0],
      previewer.decodeFunctionResult('previewFixed', previews)[0],
    ] as [BigNumber, string, Previewer.FixedMarketStructOutput[]]);

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
    }

    if (!log.args.assets) continue;

    parallel.push(Promise.all([
      getSecret(secrets, 'SLACK_TOKEN').then((token) => new WebClient(token)),
      getSecret(secrets, `SLACK_MONITORING@${chainId}`),
      getSecret(secrets, `SLACK_WHALE_ALERT@${chainId}`),

      (new Contract(address, marketABI, provider) as Market).asset()
        .then((asset) => (new Contract(asset, erc20ABI, provider) as ERC20).symbol())
        .then((symbol) => Promise.all([symbol, getSecret(secrets, `${symbol}.icon`)])),

      warmup.then(([ts, name, previews]) => {
        const {
          decimals, assets, deposits, borrows,
        } = previews.find(({ market: m }) => m.toLowerCase() === address.toLowerCase())!;
        return [ts.toString(), name, decimals, deposits.map(({
          maturity, assets: depositAssets,
        }, i) => {
          const { assets: borrowAssets } = borrows[i];
          return depositAssets.gt(borrowAssets) ? [
            formatMaturity(maturity),
            formatBigInt(depositAssets.sub(assets).mul(YEAR * WAD).div(assets.mul(maturity.sub(ts))), '%'),
            formatBigInt(borrowAssets.sub(assets).mul(YEAR * WAD).div(assets.mul(maturity.sub(ts))), '%'),
          ] : null;
        }).filter(Boolean)] as [string, string, number, [string, string, string][]];
      }),
    ]).then(([
      slack, monitoring, whaleAlert, [symbol, icon], [ts, name, decimals, arbs],
    ]) => Promise.all(([
      [arbs.length && monitoring, {
        color: '#2da44e',
        title: `${symbol} arb @ ${arbs.map(([maturity]) => maturity).join(' & ')}`,
        fields: arbs.flatMap(([maturity, depositRate, borrowRate]) => [
          { short: true, title: `deposit@${maturity}`, value: depositRate },
          { short: true, title: `borrow@${maturity}`, value: borrowRate },
        ]),
      }],
      [whaleAlert, {
        color: '#3178c6',
        title: `${formatBigInt(String(log.args.assets), symbol, decimals)} ${noCase(log.name)}`,
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
      }],
    ] as [string | undefined, Record<string, unknown>][]).map(([
      channel, props,
    ]) => channel && slack.chat.postMessage({
      channel,
      attachments: [{
        footer_icon: icon, footer: network, ts, ...props,
      }],
    })))));
  }

  await Promise.all(parallel);
}) as ActionFn;
