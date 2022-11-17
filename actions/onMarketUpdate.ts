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
import type { Market, MarketUpdateEventObject } from './types/Market';
import formatBigInt from './utils/formatBigInt';
import getSecret from './utils/getSecret';
import multicall from './utils/multicall';
import resolverABI from './abi/ReverseResolver.json';
import marketABI from './abi/Market.json';
import erc20ABI from './abi/ERC20.json';

const WAD = 10n ** 18n;

const erc20 = new Interface(erc20ABI);
const market = new Interface(marketABI);
const resolver = new Interface(resolverABI);

export default (async ({ storage, secrets, gateways }, {
  network: chainId, blockNumber, hash, from, logs, gasUsed, gasPrice,
}: TransactionEvent) => {
  const network = { 5: Network.GOERLI }[chainId] ?? Network.MAINNET;
  const etherscan = `https://${network !== Network.MAINNET ? `${network}.` : ''}etherscan.io`;
  const provider = new StaticJsonRpcProvider(gateways.getGateway(network));

  const parallel: Promise<unknown>[] = [];

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

    parallel.push((new Contract(address, marketABI, provider) as Market).asset()
      .then((asset) => multicall.connect(provider).callStatic.aggregate([
        { target: asset, callData: erc20.encodeFunctionData('symbol') },
        { target: asset, callData: erc20.encodeFunctionData('decimals') },
        {
          target: ({
            [Network.MAINNET]: '0xA2C122BE93b0074270ebeE7f6b7292C7deB45047',
          } as Record<Network, string>)[network] ?? '0x084b1c3C81545d370f3634392De611CaaBFf8148',
          callData: resolver.encodeFunctionData('name', [namehash(`${from.substring(2).toLowerCase()}.addr.reverse`)]),
        },
        { target: multicall.address, callData: multicall.interface.encodeFunctionData('getCurrentBlockTimestamp') },
      ], { blockTag: blockNumber }))
      .then(([, [symbolData, decimalsData, ensData, tsData]]) => [
        erc20.decodeFunctionResult('symbol', symbolData)[0],
        erc20.decodeFunctionResult('decimals', decimalsData)[0],
        resolver.decodeFunctionResult('name', ensData)[0],
        multicall.interface.decodeFunctionResult('getCurrentBlockTimestamp', tsData)[0],
      ] as [string, number, string, BigNumber])
      .then(([symbol, ...rest]) => Promise.all([
        symbol, ...rest,
        getSecret(secrets, `${symbol}.icon`),
        getSecret(secrets, `SLACK_WHALE_ALERT@${chainId}`),
      ]))
      .then(([symbol, decimals, ens, ts, icon, whaleAlert]) => (whaleAlert ? fetch(whaleAlert, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          attachments: [{
            author_name: ens || `${from.slice(0, 6)}…${from.slice(-4)}`,
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
            ts: ts.toNumber(),
          }],
        }),
      }) : null)));
  }

  await Promise.all(parallel);
}) as ActionFn;
