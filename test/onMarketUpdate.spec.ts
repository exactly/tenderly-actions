import 'dotenv/config';
import { env } from 'process';
import { expect, use } from 'chai';
import { TestRuntime } from '@tenderly/actions-test';
import chaiAsPromised from 'chai-as-promised';
import onMarketUpdate from '../actions/onMarketUpdate';
import payload from './payloads/payload.json';

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
    await runtime.execute(onMarketUpdate, payload);
    expect(await runtime.context.storage.getBigInt('1:0x660e2fC185a9fFE722aF253329CEaAD4C9F6F928:shareValue'))
      .to.equal(1001314617021308273n);
  });

  it('should throw when share value decreases', async () => {
    const key = '1:0x660e2fC185a9fFE722aF253329CEaAD4C9F6F928:shareValue';
    await runtime.context.storage.putBigInt(key, 4200000000000000000n);
    await expect(runtime.execute(onMarketUpdate, payload)).to.eventually.be.rejectedWith(`${key} decreased`);
  });
});
