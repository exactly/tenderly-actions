import 'dotenv/config';
import { env } from 'process';
import { expect, use } from 'chai';
import { TestRuntime } from '@tenderly/actions-test';
import chaiAsPromised from 'chai-as-promised';
import onNotifyDebtors, {
  DELAY_KEY,
  NOTIFICATIONS_KEY,
  SentNotification,
} from '../actions/onNotifyDebtors';

use(chaiAsPromised);

const {
  GATEWAY_ACCESS_KEY, SLACK_TOKEN, SLACK_MONITORING, PUSH_CHANNEL_PK, SLACK_RECEIPTS,
} = env;

// 4 weeks delay so there's always a maturity to notify if subscribers have positions
const delay = 4 * 60 * 60 * 24;

type Result = {
  lastRun: number;
  notifications: SentNotification[];
};

describe('on notify debtors', () => {
  let runtime: TestRuntime;
  const time = new Date();

  before(async () => {
    runtime = new TestRuntime();
    runtime.context.gateways.setConfig('', { accessKey: GATEWAY_ACCESS_KEY });
    await runtime.context.storage.putNumber(DELAY_KEY, delay);

    if (PUSH_CHANNEL_PK) {
      runtime.context.secrets.put('PUSH_CHANNEL_PK@5', PUSH_CHANNEL_PK);
    }
    if (SLACK_TOKEN) runtime.context.secrets.put('SLACK_TOKEN', SLACK_TOKEN);
    if (SLACK_MONITORING) {
      runtime.context.secrets.put('SLACK_MONITORING@5', SLACK_MONITORING);
    }
    if (SLACK_RECEIPTS) {
      runtime.context.secrets.put('SLACK_RECEIPTS@5', SLACK_RECEIPTS);
    }

    await runtime.execute(onNotifyDebtors, { time });
  });

  it('should store `lastRun` results', async () => {
    const { lastRun } = (await runtime.context.storage.getJson(NOTIFICATIONS_KEY)) as Result;
    expect(lastRun).to.equal(Math.floor(time.getTime() / 1000));
  });

  it('should not have failed notifications sent', async () => {
    const { notifications } = (await runtime.context.storage.getJson(NOTIFICATIONS_KEY)) as Result;
    expect(notifications.some(({ successfullySent }) => !successfullySent)).to.equal(false);
  });
});
