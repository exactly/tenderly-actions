import 'dotenv/config';
import { env } from 'process';
import { expect, use } from 'chai';
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

  beforeEach(() => {
    runtime = new TestRuntime();
    runtime.context.gateways.setConfig('', { accessKey: GATEWAY_ACCESS_KEY });
    runtime.context.secrets.put('RPC_10', RPC_10);
    if (SLACK_TOKEN) runtime.context.secrets.put('SLACK_TOKEN', SLACK_TOKEN);
    if (SLACK_MONITORING) runtime.context.secrets.put('SLACK_MONITORING@10', SLACK_MONITORING);
    if (SLACK_WHALE_ALERT) runtime.context.secrets.put('SLACK_WHALE_ALERT@10', SLACK_WHALE_ALERT);
  });

  it('should store share value', async () => {
    await runtime.execute(onMarketUpdate, payload);
    expect(await runtime.context.storage.getBigInt('10:0xa430A427bd00210506589906a71B54d6C256CEdb:shareValue'))
      .to.equal(1000098712719970367n);
  });

  it('should throw when share value decreases', async () => {
    const key = '10:0xa430A427bd00210506589906a71B54d6C256CEdb:shareValue';
    await runtime.context.storage.putBigInt(key, 4200000000000000000n);
    await expect(runtime.execute(onMarketUpdate, payload)).to.eventually.be.rejectedWith(`${key} decreased`);
  });
});
