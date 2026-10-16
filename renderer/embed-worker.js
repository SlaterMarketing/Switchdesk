// Turns text into vectors for codebase search, off the main thread. transformers.js, the ONNX
// runtime and the model all come from app://desk/models/ (downloaded once by main), so nothing is
// fetched from the internet here.
let pipeline, env;
async function setup() {
  if (pipeline) return;
  ({ pipeline, env } = await import('app://desk/models/transformers.min.js'));
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = 'app://desk/models/';
  env.useBrowserCache = false;
  env.backends.onnx.wasm.wasmPaths = {
    mjs: 'app://desk/models/ort/ort-wasm-simd-threaded.asyncify.mjs',
    wasm: 'app://desk/models/ort/ort-wasm-simd-threaded.asyncify.wasm',
  };
  env.backends.onnx.wasm.numThreads = 1;
}

let extractor = null;
async function load(model) {
  if (extractor) return extractor;
  await setup();
  // The graphics card when there is one (much faster), else the CPU.
  if (self.navigator.gpu) {
    try {
      const adapter = await self.navigator.gpu.requestAdapter();
      if (adapter) extractor = await pipeline('feature-extraction', model, { device: 'webgpu', dtype: 'q8' });
    } catch {
      extractor = null;
    }
  }
  if (!extractor) {
    extractor = await pipeline('feature-extraction', model, { device: 'wasm', dtype: 'q8' });
    extractor.__wasm = true;
  }
  return extractor;
}

self.onmessage = async ({ data }) => {
  const { id, model, texts } = data;
  try {
    let run = await load(model);
    let out;
    try {
      out = await run(texts, { pooling: 'mean', normalize: true });
    } catch (e) {
      if (run.__wasm) throw e;
      // The graphics card couldn't run it: use the CPU from now on.
      extractor = await pipeline('feature-extraction', model, { device: 'wasm', dtype: 'q8' });
      extractor.__wasm = true;
      run = extractor;
      out = await run(texts, { pooling: 'mean', normalize: true });
    }
    const dim = out.dims[out.dims.length - 1];
    const flat = out.data;
    const vectors = texts.map((_, i) => Array.from(flat.subarray(i * dim, (i + 1) * dim)));
    self.postMessage({ id, vectors });
  } catch (e) {
    self.postMessage({ id, error: String((e && e.message) || e) });
  }
};
