import 'dotenv/config';
import { env } from 'process';
import { expect, use } from 'chai';
import { TestRuntime } from '@tenderly/actions-test';
import chaiAsPromised from 'chai-as-promised';
import onMarketUpdate from '../actions/onMarketUpdate';
import borrowPayload from './payloads/borrow.json';

use(chaiAsPromised);

const {
  GATEWAY_ACCESS_KEY, SLACK_TOKEN, SLACK_MONITORING, SLACK_WHALE_ALERT,
} = env;

describe('on market update', () => {
  let runtime: TestRuntime;

  beforeEach(() => {
    runtime = new TestRuntime();
    runtime.context.gateways.setConfig('', { accessKey: GATEWAY_ACCESS_KEY });
    if (SLACK_TOKEN) runtime.context.secrets.put('SLACK_TOKEN', SLACK_TOKEN);
    if (SLACK_MONITORING) runtime.context.secrets.put('SLACK_MONITORING@1', SLACK_MONITORING);
    if (SLACK_WHALE_ALERT) runtime.context.secrets.put('SLACK_WHALE_ALERT@1', SLACK_WHALE_ALERT);
  });

  it('should store share value', async () => {
    await runtime.execute(onMarketUpdate, borrowPayload);
    expect(await runtime.context.storage.getBigInt('1:0xc4d4500326981eacD020e20A81b1c479c161c7EF:shareValue'))
      .to.equal(1000511293986130291n);
  });

  it('should throw when share value decreases', async () => {
    const key = '1:0xc4d4500326981eacD020e20A81b1c479c161c7EF:shareValue';
    await runtime.context.storage.putBigInt(key, 4200000000000000000n);
    await expect(runtime.execute(onMarketUpdate, borrowPayload)).to.eventually.be.rejectedWith(`${key} decreased`);
  });
});
