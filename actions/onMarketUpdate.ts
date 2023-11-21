import { noCase } from 'no-case';
import { Contract } from '@ethersproject/contracts';
import { AddressZero } from '@ethersproject/constants';
import { type BigNumber } from '@ethersproject/bignumber';
import { StaticJsonRpcProvider } from '@ethersproject/providers';
import { Interface, type LogDescription } from '@ethersproject/abi';
import { type ChatPostMessageArguments, WebClient } from '@slack/web-api';
import {
  type ActionFn, type GatewayNetwork, Network, type TransactionEvent,
} from '@tenderly/actions';
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
  const app = 'https://app.exact.ly';

  const [{ address: previewerAddress }, rpc] = await Promise.all([
    import(`@exactly/protocol/deployments/${network}/Previewer.json`) as Promise<{ address: string }>,
    network !== 'optimism' ? gateways.getGateway(network as GatewayNetwork) : secrets.get(`RPC_${chainId}`),
  ]);
  const provider = new StaticJsonRpcProvider(rpc);
  const previewer = new Contract(previewerAddress, previewerABI, provider) as Previewer;
  const [[, [tsData, exactlyData]], prevExactly, name, { l1Fee, l1GasPrice }] = await Promise.all([
    multicall.connect(provider).callStatic.aggregate([
      { target: multicall.address, callData: multicall.interface.encodeFunctionData('getCurrentBlockTimestamp') },
      { target: previewer.address, callData: previewer.interface.encodeFunctionData('exactly', [AddressZero]) },
    ], { blockTag: blockNumber }),
    previewer.exactly(AddressZero, { blockTag: blockNumber - 1 }),
    (network === Network.MAINNET ? provider
      : new StaticJsonRpcProvider(gateways.getGateway(Network.MAINNET))).lookupAddress(from),
    network !== 'optimism' ? { l1Fee: '', l1GasPrice: '' }
      : provider.perform('getTransactionReceipt', { transactionHash: hash }) as Promise<{ l1Fee: string; l1GasPrice: string; }>,
  ]);
  const [ts] = multicall.interface.decodeFunctionResult('getCurrentBlockTimestamp', tsData) as [BigNumber];
  const [exactly] = previewer.interface.decodeFunctionResult('exactly', exactlyData) as [Previewer.MarketAccountStructOutput[]];
  const [
    icons, slack, monitoring, whaleAlert, transactions, whaleThreshold = 0,
    utilizationThreshold = 0,
  ] = await Promise.all([
    getIcons(storage, exactly.map(({ assetSymbol }) => assetSymbol)),
    getSecret(secrets, 'SLACK_TOKEN').then((token) => new WebClient(token)),
    getSecret(secrets, `SLACK_MONITORING@${chainId}`),
    getSecret(secrets, `SLACK_WHALE_ALERT@${chainId}`),
    getSecret(secrets, `SLACK_TRANSACTIONS@${chainId}`),
    storage.getNumber('WHALE_USD_THRESHOLD'),
    storage.getNumber('UTILIZATION_THRESHOLD'),
  ]);
  const ethPrice = findMarket(exactly, ({ assetSymbol }) => assetSymbol === 'WETH')!.usdPrice.toBigInt();

  const parallel: Promise<unknown>[] = [];

  for (const { address, data, topics } of logs) {
    let log: LogDescription;
    try { log = market.parseLog({ data, topics }); } catch { continue; }

    if (log.name === 'MarketUpdate') {
      const {
        assetSymbol, fixedPools, totalFloatingDepositAssets, totalFloatingDepositShares,
        totalFloatingBorrowAssets,
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

      const assets = totalFloatingDepositAssets.toBigInt();
      const floatingDebt = totalFloatingBorrowAssets.toBigInt();
      const fixedAssets = fixedPools.reduce((total, { supplied, borrowed }) => (
        total + supplied.toBigInt() - borrowed.toBigInt()), 0n);
      const debt = floatingDebt - (fixedAssets < 0n ? fixedAssets : 0n);
      const utilization = Number((debt * WAD) / assets) / 10 ** 18;

      if (utilization >= utilizationThreshold) {
        parallel.push(slack.chat.postMessage({
          channel: monitoring,
          attachments: [{
            color: 'warning',
            title: `${assetSymbol} utilization above threshold`,
            title_link: `${app}/${assetSymbol}`,
            fields: [
              {
                short: true,
                title: 'global utilization',
                value: utilization.toLocaleString(undefined, { style: 'percent', maximumFractionDigits: 2 }),
              },
              { short: true, title: 'floating utilization', value: formatBigInt((floatingDebt * WAD) / assets, '%') },
            ],
            footer_icon: icons[assetSymbol],
            footer: network,
            ts: ts.toString(),
          }],
        }));
      }

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
          color: 'warning',
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

    if (!log.args.assets) continue;

    const assets = log.args.assets as BigNumber;
    const exaMarket = findMarket(exactly, address);
    if (!exaMarket) continue;

    const { assetSymbol, decimals, usdPrice } = exaMarket;
    const message: Omit<ChatPostMessageArguments, 'channel'> = {
      attachments: [{
        color: {
          [Network.MAINNET]: '#627EEA',
          optimism: '#EE2939',
        }[network],
        title: `${formatBigInt(assets, assetSymbol, decimals)} ${noCase(log.name)}`,
        title_link: `${etherscan}/tx/${hash}`,
        author_link: `${etherscan}/address/${from}`,
        author_name: name || `${from.slice(0, 6)}…${from.slice(-4)}`,
        fields: [
          { short: true, title: 'gas price', value: formatBigInt(l1GasPrice || gasPrice, 'gwei') },
          { short: true, title: 'gas used', value: BigInt(gasUsed).toLocaleString() },
          {
            short: true,
            title: 'tx cost',
            value: formatBigInt(((BigInt(gasUsed) * BigInt(gasPrice) + BigInt(l1Fee)) * ethPrice) / WAD, '$'),
          },
          ...'maturity' in log.args
            ? [{ title: 'maturity', value: formatMaturity(log.args.maturity as BigNumber), short: true }] : [],
        ],
        footer_icon: icons[assetSymbol],
        footer: network,
        ts: ts.toString(),
      }],
    };
    if (transactions) parallel.push(slack.chat.postMessage({ ...message, channel: transactions }));
    if (whaleAlert && Number(usdPrice.mul(assets)) / 10 ** (18 + decimals) >= whaleThreshold) {
      parallel.push(slack.chat.postMessage({ ...message, channel: whaleAlert }));
    }
  }

  await Promise.all(parallel);
}) as ActionFn;
