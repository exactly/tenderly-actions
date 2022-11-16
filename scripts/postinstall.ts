import { resolve } from 'path';
import { runTypeChain } from 'typechain';
import { writeFile, mkdir } from 'fs/promises';
import MarketWETH from '@exactly-protocol/protocol/deployments/mainnet/MarketWETH.json';
import DAI from '@exactly-protocol/protocol/deployments/mainnet/DAI.json';

const rootDir = resolve(__dirname, '..');

const writeABI = async (path: string, abi: unknown[]) => {
  await writeFile(resolve(rootDir, path), JSON.stringify(abi, null, 2));
  return path;
};

mkdir('actions/abi', { recursive: true }).then(async () => {
  const allFiles = await Promise.all([
    writeABI('actions/abi/Market.json', MarketWETH.abi),
    writeABI('actions/abi/ERC20.json', DAI.abi),
  ]);
  await runTypeChain({
    filesToProcess: allFiles,
    allFiles,
    target: 'ethers-v5',
    outDir: 'actions/types',
    cwd: rootDir,
  });
}).catch((error) => { throw error; });
