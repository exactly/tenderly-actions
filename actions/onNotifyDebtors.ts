import { StaticJsonRpcProvider } from '@ethersproject/providers';
import { ActionFn, Network, PeriodicEvent } from '@tenderly/actions';
import { channels, payloads } from '@pushprotocol/restapi';
import { formatUnits } from '@ethersproject/units';
import { BigNumber } from '@ethersproject/bignumber';
import { Wallet } from '@ethersproject/wallet';
import { WebClient } from '@slack/web-api';
import { Interface } from '@ethersproject/abi';
import getSecret from './utils/getSecret';
import multicall from './utils/multicall';

import type { Previewer, PreviewerInterface } from './types/Previewer';
import previewerABI from './abi/Previewer.json';

export const DELAY_KEY = 'notificationsDelay';
export const NOTIFICATIONS_KEY = 'notificationsResults';

const NETWORKS = {
  // TODO: uncomment when push ready on mainnet
  // 1: {
  //   channel: '0x',
  //   env: 'prod',
  //   app: 'app',
  // },
  5: {
    channel: '0xB51210b372D50c290BA36bD464F903eDe8939A1B',
    env: 'staging',
    app: 'goerli',
  },
};

export type SentNotification = {
  totalDebt: string;
  chainId: number;
  error?: unknown;
  maturityISO: string;
  subscriber: string;
  successfullySent: boolean;
  symbol: string;
};

enum NotificationType {
  broadcast = 1,
  target = 3,
  subset = 4,
}

const titleMsg = (daysLeft: number, symbol: string) => {
  if (daysLeft > 1) {
    return `Your ${symbol} fixed borrow expires in ${daysLeft} days`;
  }
  if (daysLeft === 1) return `Your ${symbol} fixed borrow expires tomorrow`;
  if (daysLeft === 0) return `Your ${symbol} fixed borrow expires today`;
  if (daysLeft === -1) return `Your ${symbol} fixed borrow expired yesterday`;
  return `Your ${symbol} fixed borrow expired ${-daysLeft} days ago`;
};

const bodyIntro = (daysLeft: number, decimals: number, principal: BigNumber, symbol: string) => {
  const yourBorrow = `Your ${formatUnits(principal, decimals)} ${symbol} fixed borrow`;

  if (daysLeft > 1) {
    return `${yourBorrow} expires in ${daysLeft} days`;
  }
  if (daysLeft === 1) return `${yourBorrow} expires tomorrow`;
  if (daysLeft === 0) return `${yourBorrow} expires today`;
  if (daysLeft === -1) return `${yourBorrow} expired yesterday`;
  return `${yourBorrow} expired ${-daysLeft} days ago`;
};

const bodyMsg = (
  daysLeft: number,
  decimals: number,
  principal: BigNumber,
  symbol: string,
  totalDebt: string,
  penaltyRate: BigNumber,
) => {
  const intro = bodyIntro(daysLeft, decimals, principal, symbol);
  const debtOf = `debt of ${totalDebt} ${symbol}`;
  const thePenalty = `The penalty for not repaying on time is ${Number(formatUnits(penaltyRate.mul(8_640_000), 18)).toFixed(2)}% per day.`;

  if (daysLeft >= 0) {
    return `${intro}. Please, remember to repay your ${debtOf} on time. ${thePenalty}`;
  }
  return `${intro}. Please, repay your ${debtOf} ASAP. ${thePenalty}`;
};

const previewer = new Interface(previewerABI) as PreviewerInterface;

export default (async ({ storage, secrets, gateways }, { time }: PeriodicEvent) => {
  try {
    const delay = (await storage.getNumber(DELAY_KEY)) ?? 60 * 60 * 24;
    const now = Math.floor(time.getTime() / 1_000);

    const results = await Promise.all(
      Object.entries(NETWORKS).map(async ([chainId, { channel, env, app }]) => {
        const signer = new Wallet(`0x${await secrets.get(`PUSH_CHANNEL_PK@${chainId}`)}`);
        const network = { 5: Network.GOERLI }[chainId] ?? Network.MAINNET;
        const provider = new StaticJsonRpcProvider(gateways.getGateway(network));

        // eslint-disable-next-line no-underscore-dangle
        const subscribers = await (channels._getSubscribers({ channel, env }) as Promise<string[]>)
          .catch((e) => {
            const msg = `Error getting subscribers for chainId ${chainId}`;
            console.error(msg, e);
            throw new Error(msg);
          });

        const previewerAddress = (await import(`@exactly-protocol/protocol/deployments/${network}/Previewer.json`)) as ({ address: string });
        const [, exactlyData] = await multicall.connect(provider).callStatic.aggregate(
          subscribers.map((account) => ({
            target: previewerAddress.address,
            callData: previewer.encodeFunctionData('exactly', [account]),
          })),
        );

        const chainResult = await Promise.all(
          subscribers.map((subscriber: string, index) => {
            const [exactly] = previewer.decodeFunctionResult('exactly', exactlyData[index]) as [Previewer.MarketAccountStructOutput[]];
            return exactly.map(({
              assetSymbol: symbol, decimals, penaltyRate, fixedBorrowPositions,
            }) => fixedBorrowPositions.map(
              async ({ maturity, position: { principal }, previewValue }) => {
                if (previewValue.isZero() || Number(maturity) - now > delay) return null;
                const days = Math.floor((Number(maturity) - now) / 86_400);
                const title = titleMsg(days, symbol);
                const totalDebt = formatUnits(previewValue, decimals);

                const body = bodyMsg(days, decimals, principal, symbol, totalDebt, penaltyRate);
                const maturityISO = new Date(Number(maturity) * 1_000).toISOString().slice(0, 10);
                try {
                  const response = await payloads.sendNotification({
                    channel,
                    env,
                    signer,
                    type: NotificationType.target,
                    recipients: subscriber,
                    notification: { title, body },
                    payload: {
                      title, body, cta: `https://${app}.exact.ly/dashboard`, img: '', // TODO: exa asset img?
                    },
                    identityType: 0, // minimal payload
                  });
                  return {
                    symbol,
                    maturityISO,
                    subscriber,
                    successfullySent: response?.status === 204,
                    totalDebt: formatUnits(previewValue, decimals),
                    chainId: Number(chainId),
                  };
                } catch (error) {
                  return {
                    symbol,
                    maturityISO,
                    subscriber,
                    successfullySent: false,
                    error,
                    totalDebt: formatUnits(previewValue, decimals),
                    chainId: Number(chainId),
                  };
                }
              },
            )).flat();
          }).flat(),
        ) as SentNotification[];

        const [slack, monitoring, receipts] = await Promise.all([
          getSecret(secrets, 'SLACK_TOKEN').then((token) => new WebClient(token)),
          getSecret(secrets, `SLACK_MONITORING@${chainId}`),
          getSecret(secrets, `SLACK_RECEIPTS@${chainId}`),
        ]);

        if (!receipts) console.error(`No slack receipts channel found for chainId ${chainId}`);
        else {
          const sent = chainResult.filter(({ successfullySent }) => successfullySent);
          await slack.chat.postMessage({
            channel: receipts,
            attachments: [
              {
                color: 'good',
                title: `Sent ${sent.length} notifications successfully for ${network} network.`,
                fields: sent.flatMap(
                  ({
                    symbol, maturityISO, subscriber, totalDebt,
                  }) => [
                    { title: 'symbol', value: symbol, short: true },
                    { title: 'maturity', value: maturityISO, short: true },
                    { title: 'total debt', value: totalDebt },
                    { title: 'account', value: subscriber },
                  ],
                ),
                footer: network,
                ts: now.toString(),
              },
            ],
          });
        }

        if (!monitoring) {
          console.error(`No slack monitoring channel found for chainId ${chainId}`);
          return chainResult;
        }
        const failed = chainResult.filter(({ successfullySent }) => !successfullySent);
        if (failed.length) {
          await slack.chat.postMessage({
            channel: monitoring,
            attachments: [
              {
                color: 'danger',
                title: `${failed.length} notifications failed for chain ${chainId} subscribers.`,
                fields: failed.flatMap(
                  ({
                    symbol, maturityISO, subscriber, error, totalDebt,
                  }) => [
                    { short: true, title: 'symbol', value: symbol },
                    { short: true, title: 'maturity', value: maturityISO },
                    { short: true, title: 'total debt', value: totalDebt },
                    {
                      short: true,
                      title: 'error',
                      value: error instanceof Error ? error?.message : 'Unknown error.',
                    },
                    { title: 'account', value: subscriber },
                  ],
                ),
                footer: network,
                ts: now.toString(),
              },
            ],
          });
        }
        return chainResult;
      }),
    );

    console.log('***********************************');
    console.log('Sent notifications: ');
    console.table(results.flat(2));
    await storage.putJson(NOTIFICATIONS_KEY, {
      lastRun: now,
      notifications: results.flat(2),
    });
    console.log('***********************************');
  } catch (error) {
    console.error(error);
  }
}) as ActionFn;
