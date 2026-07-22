let cachedAdd: ((a: number, b: number) => number) | null = null;

export async function loadAddWasm(): Promise<(a: number, b: number) => number> {
  if (cachedAdd) return cachedAdd;

  const url = '/wasm/add.wasm';

  let instance: WebAssembly.Instance;

  if ('instantiateStreaming' in WebAssembly) {
    try {
      const result = await WebAssembly.instantiateStreaming(fetch(url));
      instance = result.instance;
    } catch {
      const buf = await (await fetch(url)).arrayBuffer();
      const result = await WebAssembly.instantiate(buf);
      instance = result.instance;
    }
  } else {
    const buf = await (await fetch(url)).arrayBuffer();
    const result = await WebAssembly.instantiate(buf);
    instance = result.instance;
  }

  const exports = instance.exports as unknown as { add: (a: number, b: number) => number };
  cachedAdd = exports.add;
  return cachedAdd;
}
