import { Contract } from '@ethersproject/contracts';
import type { Multicall3 } from '../types/Multicall3';
import multicall3ABI from '../abi/Multicall3.json';

export default new Contract('0xcA11bde05977b3631167028862bE2a173976CA11', multicall3ABI) as Multicall3;
