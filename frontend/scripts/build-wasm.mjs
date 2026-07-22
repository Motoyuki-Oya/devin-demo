import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import wabt from 'wabt';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const projectRoot = path.resolve(__dirname, '..');
const watPath = path.join(projectRoot, 'wasm', 'add.wat');
const outDir = path.join(projectRoot, 'public', 'wasm');
const outPath = path.join(outDir, 'add.wasm');

const wabtApi = await wabt();
const wat = await readFile(watPath, 'utf8');

const module = wabtApi.parseWat('add.wat', wat);
module.resolveNames();
module.validate();

const { buffer } = module.toBinary({ log: false, write_debug_names: true });

await mkdir(outDir, { recursive: true });
await writeFile(outPath, Buffer.from(buffer));

process.stdout.write(`Built WASM: ${path.relative(projectRoot, outPath)}\n`);
