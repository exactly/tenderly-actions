import type { BigNumberish } from '@ethersproject/bignumber';

export default (maturity: BigNumberish) => new Date(Number(maturity) * 1_000)
  .toISOString().slice(0, 10);
