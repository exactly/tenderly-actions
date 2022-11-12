import { render } from 'mustache';
import { readdir, readFile, writeFile } from 'fs/promises';
import {
  basename, extname, join, resolve,
} from 'path';

const dir = resolve(__dirname, '../node_modules/@exactly-protocol/protocol/deployments');

readdir(dir, { withFileTypes: true })
  .then((files) => files.filter((file) => file.isDirectory()).map(({ name }) => join(dir, name)))
  .then((dirs) => Promise.all(dirs.map(async (path) => {
    const [chainId, files] = await Promise.all([readFile(join(path, '.chainId')), readdir(path)]);
    return Promise.all(files.filter((file) => extname(file) === '.json').map(async (file) => {
      if (basename(file, '.json').endsWith('_Implementation')) return null;

      const buffer = await readFile(join(path, file));
      const { address, abi } = JSON.parse(buffer.toString()) as Deployment;

      if (!abi?.some(({ type, name }) => type === 'event' && name === 'MarketUpdate')) return null;

      return { chainId: Number(chainId), address };
    }));
  })))
  .then((result) => result.flat().filter(Boolean) as { chainId: number; address: string }[])
  .then(async (markets) => writeFile(
    'tenderly.yaml',
    render((await readFile('tenderly.template.yaml')).toString(), { markets }),
  ))
  .catch((error) => { throw error; });

interface Deployment {
  address: string;
  abi?: {
    name?: string;
    type?: string;
  }[];
}
