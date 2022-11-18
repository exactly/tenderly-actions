import fetch from 'cross-fetch';
import { noCase } from 'no-case';
import { Network } from '@tenderly/actions';
import { namehash } from '@ethersproject/hash';
import { Contract } from '@ethersproject/contracts';
import { Interface } from '@ethersproject/abi';
import { StaticJsonRpcProvider } from '@ethersproject/providers';
import type { BigNumber } from '@ethersproject/bignumber';
import type { LogDescription } from '@ethersproject/abi';
import type { ActionFn, TransactionEvent } from '@tenderly/actions';
import type { Market, MarketInterface, MarketUpdateEventObject } from './types/Market';
import type { PreviewerInterface, Previewer } from './types/Previewer';
import type { ReverseResolverInterface } from './types/ReverseResolver';
import type { ERC20 } from './types/ERC20';
import formatBigInt from './utils/formatBigInt';
import getSecret from './utils/getSecret';
import multicall from './utils/multicall';
import previewerABI from './abi/Previewer.json';
import resolverABI from './abi/ReverseResolver.json';
import marketABI from './abi/Market.json';
import erc20ABI from './abi/ERC20.json';

const WAD = 10n ** 18n;

const market = new Interface(marketABI) as MarketInterface;
const resolver = new Interface(resolverABI) as ReverseResolverInterface;
const previewer = new Interface(previewerABI) as PreviewerInterface;

export default (async ({ storage, secrets, gateways }, {
  network: chainId, blockNumber, hash, from, logs, gasUsed, gasPrice,
}: TransactionEvent) => {
  const network = { 5: Network.GOERLI }[chainId] ?? Network.MAINNET;
  const etherscan = `https://${network !== Network.MAINNET ? `${network}.` : ''}etherscan.io`;
  const provider = new StaticJsonRpcProvider(gateways.getGateway(network));

  const global = import(`@exactly-protocol/protocol/deployments/${network}/Previewer.json`)
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
    ] as [BigNumber, string, Previewer.FixedMarketStruct[]]);

  const parallel: Promise<unknown>[] = [global];

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
      getSecret(secrets, `SLACK_WHALE_ALERT@${chainId}`),

      (new Contract(address, marketABI, provider) as Market).asset()
        .then((asset) => (new Contract(asset, erc20ABI, provider) as ERC20).symbol())
        .then((symbol) => Promise.all([symbol, getSecret(secrets, `${symbol}.icon`)])),

      global.then(([ts, name, previews]) => {
        const { decimals, deposits, borrows } = previews.find(({
          market: marketAddress,
        }) => String(marketAddress).toLowerCase() === address.toLowerCase())!;
        return [ts.toNumber(), name, Number(decimals), deposits, borrows] as [
          number, string, number, Previewer.FixedPreviewStruct[], Previewer.FixedPreviewStruct[],
        ];
      }),
    ]).then(([
      whaleAlert,
      [symbol, icon],
      [ts, name, decimals],
    ]) => Promise.all([
      whaleAlert ? fetch(whaleAlert, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          attachments: [{
            author_name: name || `${from.slice(0, 6)}…${from.slice(-4)}`,
            author_link: `${etherscan}/address/${from}`,
            title_link: `${etherscan}/tx/${hash}`,
            title: `${formatBigInt(String(log.args.assets), symbol, decimals)} ${noCase(log.name)}`,
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
            footer_icon: icon,
            footer: symbol,
            ts,
          }],
        }),
      }) : null,
    ])));
  }

  await Promise.all(parallel);
}) as ActionFn;
