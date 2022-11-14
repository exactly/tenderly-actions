import { TestRuntime } from '@tenderly/actions-test';
import { expect, use } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import onMarketUpdate from '../actions/onMarketUpdate';
import borrowPayload from './payloads/borrow.json';

use(chaiAsPromised);

describe('on market update', () => {
  let runtime: TestRuntime;

  beforeEach(() => { runtime = new TestRuntime(); });

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
