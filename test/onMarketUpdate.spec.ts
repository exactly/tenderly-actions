import 'dotenv/config';
import { env } from 'process';
import { beforeEach, describe, test } from 'bun:test';
import { TestRuntime } from '@tenderly/actions-test';
import onMarketUpdate from '../actions/onMarketUpdate';
import payload from './payloads/payload.json';

const { GATEWAY_ACCESS_KEY, SLACK_TOKEN, RPC_10 = 'https://mainnet.optimism.io' } = env;

describe('on market update', () => {
  let runtime: TestRuntime;

  beforeEach(async () => {
    runtime = new TestRuntime();
    runtime.context.secrets.put('RPC_10', RPC_10);
    runtime.context.gateways.setConfig('', { accessKey: GATEWAY_ACCESS_KEY });
    await runtime.context.storage.putStr('OP.icon', 'https://cryptologos.cc/logos/optimism-ethereum-op-logo.png');
    await runtime.context.storage.putStr('UTILIZATION_THRESHOLD', '0.8');
    if (SLACK_TOKEN) runtime.context.secrets.put('SLACK_TOKEN', SLACK_TOKEN);
    for (const [key, value] of Object.entries(env)) {
      if (key.startsWith('SLACK_')) runtime.context.secrets.put(`${key}@${payload.network}`, value!);
      else await runtime.context.storage.putStr(key, value!);
    }
  });

  test('should execute', () => runtime.execute(onMarketUpdate, payload));
});
