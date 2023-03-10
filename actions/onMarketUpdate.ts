import { noCase } from 'no-case';
import { Network } from '@tenderly/actions';
import { WebClient } from '@slack/web-api';
import { Contract } from '@ethersproject/contracts';
import { Interface } from '@ethersproject/abi';
import { AddressZero } from '@ethersproject/constants';
import { StaticJsonRpcProvider } from '@ethersproject/providers';
import type { BigNumber } from '@ethersproject/bignumber';
import type { LogDescription } from '@ethersproject/abi';
import type { ActionFn, TransactionEvent } from '@tenderly/actions';
import type { MarketInterface } from './types/Market';
import type { Previewer } from './types/Previewer';
import formatMaturity from './utils/formatMaturity';
import formatBigInt from './utils/formatBigInt';
import findMarket from './utils/findMarket';
import getSecret from './utils/getSecret';
import multicall from './utils/multicall';
import getIcons from './utils/getIcons';
import previewerABI from './abi/Previewer.json';
import marketABI from './abi/Market.json';

const WAD = 10n ** 18n;

const market = new Interface(marketABI) as MarketInterface;

export default (async ({ storage, secrets, gateways }, {
  network: chainId, blockNumber, hash, from, logs, gasUsed, gasPrice,
}: TransactionEvent) => {
  const network = { 5: Network.GOERLI, 10: 'optimism' }[chainId] ?? Network.MAINNET;
  const etherscan = {
    5: 'https://goerli.etherscan.io',
    10: 'https://optimistic.etherscan.io',
  }[chainId] ?? 'https://etherscan.io';

  const [{ address: previewerAddress }, rpc] = await Promise.all([
    import(`@exactly-protocol/protocol/deployments/${network}/Previewer.json`) as Promise<{ address: string }>,
    network in Network ? gateways.getGateway(network as Network) : secrets.get(`RPC_${chainId}`),
  ]);
  const provider = new StaticJsonRpcProvider(rpc);
  const previewer = new Contract(previewerAddress, previewerABI, provider) as Previewer;
  const [[, [tsData, exactlyData]], prevExactly, name] = await Promise.all([
    multicall.connect(provider).callStatic.aggregate([
      { target: multicall.address, callData: multicall.interface.encodeFunctionData('getCurrentBlockTimestamp') },
      { target: previewer.address, callData: previewer.interface.encodeFunctionData('exactly', [AddressZero]) },
    ], { blockTag: blockNumber }),
    previewer.exactly(AddressZero, { blockTag: blockNumber - 1 }),
    (network === Network.MAINNET ? provider
      : new StaticJsonRpcProvider(gateways.getGateway(Network.MAINNET))).lookupAddress(from),
  ]);
  const [ts] = multicall.interface.decodeFunctionResult('getCurrentBlockTimestamp', tsData) as [BigNumber];
  const [exactly] = previewer.interface.decodeFunctionResult('exactly', exactlyData) as [Previewer.MarketAccountStructOutput[]];
  const [icons, slack, monitoring, whaleAlert] = await Promise.all([
    getIcons(storage, exactly.map(({ assetSymbol }) => assetSymbol)),
    getSecret(secrets, 'SLACK_TOKEN').then((token) => new WebClient(token)),
    getSecret(secrets, `SLACK_MONITORING@${chainId}`),
    getSecret(secrets, `SLACK_WHALE_ALERT@${chainId}`),
  ]);

  const parallel: Promise<unknown>[] = [];

  for (const { address, data, topics } of logs) {
    let log: LogDescription;
    try { log = market.parseLog({ data, topics }); } catch { continue; }

    if (log.name === 'MarketUpdate') {
      const {
        assetSymbol, fixedPools, totalFloatingDepositAssets, totalFloatingDepositShares,
      } = findMarket(exactly, address)!;
      const {
        totalFloatingDepositAssets: prevAssets, totalFloatingDepositShares: prevShares,
      } = findMarket(prevExactly, address)!;

      const shareValue = totalFloatingDepositShares.isZero() ? 0n
        : (totalFloatingDepositAssets.toBigInt() * WAD) / totalFloatingDepositShares.toBigInt();
      const prevShareValue = prevShares.isZero() ? 0n
        : (prevAssets.toBigInt() * WAD) / prevShares.toBigInt();
      if (shareValue < prevShareValue) parallel.push(Promise.reject(new Error('share value decreased')));

      if (!monitoring) continue;

      const arbs = fixedPools.map(({ maturity, depositRate, minBorrowRate }) => (
        depositRate.gt(minBorrowRate) ? [
          formatMaturity(maturity),
          formatBigInt(depositRate, '%'),
          formatBigInt(minBorrowRate, '%'),
        ] : null
      )).filter(Boolean) as [string, string, string][];
      if (!arbs.length) continue;

      parallel.push(slack.chat.postMessage({
        channel: monitoring,
        attachments: [{
          color: '#2da44e',
          title: `${assetSymbol} arb @ ${arbs.map(([maturity]) => maturity).join(' & ')}`,
          fields: arbs.flatMap(([maturity, depositRate, borrowRate]) => [
            { short: true, title: `deposit@${maturity}`, value: depositRate },
            { short: true, title: `borrow@${maturity}`, value: borrowRate },
          ]),
          footer_icon: icons[assetSymbol],
          footer: network,
          ts: ts.toString(),
        }],
      }));
    }

    if (!whaleAlert || !log.args.assets) continue;

    const { assetSymbol, decimals } = findMarket(exactly, address)!;
    parallel.push(slack.chat.postMessage({
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
    }));
  }

  await Promise.all(parallel);
}) as ActionFn;
