import 'dotenv/config';
import { use } from 'chai';
import { env } from 'process';
import { TestRuntime } from '@tenderly/actions-test';
import chaiAsPromised from 'chai-as-promised';
import onMarketUpdate from '../actions/onMarketUpdate';
import payload from './payloads/payload.json';

use(chaiAsPromised);

const {
  GATEWAY_ACCESS_KEY, SLACK_TOKEN, SLACK_MONITORING, SLACK_WHALE_ALERT, RPC_10 = 'https://mainnet.optimism.io',
} = env;

describe('on market update', () => {
  let runtime: TestRuntime;

  beforeEach(async () => {
    runtime = new TestRuntime();
    runtime.context.secrets.put('RPC_10', RPC_10);
    runtime.context.gateways.setConfig('', { accessKey: GATEWAY_ACCESS_KEY });
    await runtime.context.storage.putStr('OP.icon', 'https://cryptologos.cc/logos/optimism-ethereum-op-logo.png');
    if (SLACK_TOKEN) runtime.context.secrets.put('SLACK_TOKEN', SLACK_TOKEN);
    if (SLACK_MONITORING) runtime.context.secrets.put(`SLACK_MONITORING@${payload.network}`, SLACK_MONITORING);
    if (SLACK_WHALE_ALERT) runtime.context.secrets.put(`SLACK_WHALE_ALERT@${payload.network}`, SLACK_WHALE_ALERT);
  });

  it('should execute', async () => {
    await runtime.execute(onMarketUpdate, payload);
  });
});
