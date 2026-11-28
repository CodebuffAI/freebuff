# Compiling C and C++ to WebAssembly with Emscripten

Use Emscripten (`emcc` and `em++`) to compile C and C++ into high-performance
WebAssembly (Wasm) modules for the browser.

## 1. Recommended Emscripten Compilation Flags

When compiling and linking with `emcc` or `em++`, use modern modular flags:

- `-sSTRICT`: Opt into strict modern Emscripten behavior and disable deprecated
  or legacy compatibility features.
- `-sEXPORT_ES6`: Emit a standard ES6 module (`import`/`export`). This option
  automatically implies `-sMODULARIZE`, encapsulating generated code so it does
  not pollute the global namespace.
- `-sENVIRONMENT=web` (or `-sENVIRONMENT=worker` when running solely inside a
  Web Worker, or `-sENVIRONMENT=web,worker` for both): Strip Node.js and shell
  runtime support code to minimize bundle size.
- `-sALLOW_MEMORY_GROWTH`: Allow the WebAssembly linear memory heap to expand
  dynamically when allocations exceed the initial heap size.
- `-Werror -Wall`: Treat compiler warnings as errors to catch C/C++ bugs and
  invalid compiler settings early.
- `-O3`, `-Os`, or `-Oz` with `-flto`: In release builds, choose `-O3` when
  runtime performance is most critical, or `-Os` / `-Oz` when minimizing binary
  payload size is the priority. Pass `-flto` during both compilation and
  linking for Link-Time Optimization.

### Command-Line Style

Keep `emcc` and `em++` invocations clean, minimal, and consistent:

- **Omit settings that are enabled by default**: Do not pass redundant flags
  that are already default in modern Emscripten, such as `-sWASM`, or
  `-sMODULARIZE` when `-sEXPORT_ES6` is already specified.
- **Omit the `=1` suffix on boolean `-s` flags**: Write `-sSTRICT`,
  `-sEXPORT_ES6`, and `-sALLOW_MEMORY_GROWTH` rather than `-sSTRICT=1`,
  `-sEXPORT_ES6=1`, or `-sALLOW_MEMORY_GROWTH=1`.
- **Prefer standard compiler flags over Emscripten-specific ones**: Use
  `-pthread` instead of `-sUSE_PTHREADS`, and `-m64` instead of `-sMEMORY64`.
- **Use simple comma-separated lists**: For list-based settings, pass
  comma-separated values without brackets or quotes (for example,
  `-sEXPORTED_FUNCTIONS=_render,_malloc,_free` and
  `-sEXPORTED_RUNTIME_METHODS=HEAPU8`) rather than JSON arrays like
  `-sEXPORTED_FUNCTIONS=['_render','_malloc','_free']`.
- **Use response files for long lists**: If an export list is large, pass a
  response file (`@filename`) instead of a long inline list (for example,
  `-sEXPORTED_FUNCTIONS=@exported_funcs.txt`).
- **Use separate compilation for multi-file projects**: Compile `.c` / `.cpp`
  sources to `.o` object files (`em++ -c`) before linking them into the final
  module rather than combining everything into a single monolithic invocation.

```bash
# Compile C++ source to an object file
em++ -c renderer.cpp -o renderer.o -O3 -flto -Werror -Wall

# Link into an ES6 WebAssembly module targeting a Web Worker
em++ renderer.o -o renderer.js \
  -O3 -flto \
  -sSTRICT \
  -sEXPORT_ES6 \
  -sENVIRONMENT=worker \
  -sALLOW_MEMORY_GROWTH \
  -sEXPORTED_FUNCTIONS=_render_frame,_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=HEAPU8
```

### Debug vs. Release Profiles

Keep compile and link flags consistent within each build profile, and never
ship debug information in production:

- **Release builds**: Use `-O3`, `-Os`, or `-Oz` combined with `-flto` on both
  compile and link steps, and omit `-g` and `-sASSERTIONS`. Add `--closure=1`
  when linking to minify the generated JavaScript glue code unless an external
  bundler already minifies it.
- **Debug builds**: Use `-g` when compiling and `-g`, `-gline-tables-only`, or
  `-gsource-map` when linking, alongside `-sASSERTIONS`. Avoid optimization
  flags (`-O2`, `-O3`, `-Os`, `-Oz`) and `-flto` in debug builds for faster
  compilation and accurate source-level debugging.

## 2. JavaScript-WebAssembly Boundary Efficiency

Avoid high-frequency calls across the JavaScript-WebAssembly boundary. Calling
an exported Wasm function per pixel, per audio sample, or per vertex incurs
boundary overhead that negates Wasm performance gains.

Instead, design C/C++ entry points to process entire buffers or memory regions
in a single call and read or write the contiguous buffer in linear memory:

```js
import initRenderer from './renderer.js';

const wasm = await initRenderer();
const byteLength = width * height * 4;
const ptr = wasm._malloc(byteLength);

try {
  wasm._render_frame(ptr, width, height, samples);
  const pixels = new Uint8ClampedArray(
    wasm.HEAPU8.buffer,
    ptr,
    byteLength,
  ).slice();
  self.postMessage({ pixels, width, height }, [pixels.buffer]);
} finally {
  wasm._free(ptr);
}
```

Note: Accessing `wasm.HEAPU8.buffer` directly after calls that may grow memory
requires reading `wasm.HEAPU8` fresh after the Wasm call returns, because
`-sALLOW_MEMORY_GROWTH` detaches the previous `ArrayBuffer` when resizing.

## 3. Avoid Blocking the Main Thread

The browser relies on cooperative multitasking on the main UI thread. Any
WebAssembly call that takes more than a few milliseconds (such as image
rendering, ray tracing, physics simulation, or heavy parsing) **must not** run
synchronously on the main thread, or it will freeze page rendering and input.

Use one of these approaches to keep the UI responsive:

1. **Run the WebAssembly module in a Web Worker**: Instantiate and call the
   ES6 Wasm module inside a dedicated module Worker
   (`new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })`),
   and pass rendered buffers back via `postMessage` with transferable
   `ArrayBuffer` objects.
2. **Use multithreading (`-pthread`)**: Offload heavy compute across background
   workers using standard POSIX threads. Note that `-pthread` requires
   `SharedArrayBuffer`, which requires serving the page in a cross-origin
   isolated context (`Cross-Origin-Opener-Policy: same-origin` and
   `Cross-Origin-Embedder-Policy: require-corp`).
3. **Yield to the browser event loop**: Restructure continuous loops in C/C++
   to run one frame at a time via `emscripten_set_main_loop`, or use
   JavaScript Promise Integration (`-sJSPI`) / Asyncify (`-sASYNCIFY`) when
   synchronous C/C++ code must pause for asynchronous JavaScript APIs.

## 4. Test Runtime Execution and Memory Limits

Always run and verify the compiled WebAssembly module in a real browser
environment and confirm that no warnings or unhandled errors appear in the
console:

- **Validate with `-sASSERTIONS` during development**: Build and test with
  `-sASSERTIONS` enabled to catch invalid memory accesses, missing exports, or
  ABI mismatches early, then remove `-sASSERTIONS` for the final release build.
- **Watch for stack overflows in recursive C/C++ code**: Emscripten's default
  execution stack size (`-sSTACK_SIZE`) is 64 KB, which is much smaller than
  native OS stacks. Deeply recursive algorithms (such as recursive ray tracers
  or tree traversals) can overflow the stack and corrupt linear memory unless
  converted to an iterative loop or linked with a larger stack (for example,
  `-sSTACK_SIZE=1MB`).

## 5. Avoid Dynamic Linking if Possible

Emscripten works best with static linking and static archive libraries (`.a`).
Shared libraries (`.so`, `.dylib`, `.dll`) and dynamic linking (`-sMAIN_MODULE`
/ `-sSIDE_MODULE`) add code-size and runtime overhead and should be avoided
unless runtime plugin loading is strictly required.

## 6. Porting Existing C/C++ Libraries and Build Integration

When integrating C/C++ compilation into a web application project, wire the
`emcc` / `em++` build into the project's build pipeline (such as the `"build"`
script in `package.json`) so that building the project compiles the WebAssembly
artifacts before bundling.

When building third-party C/C++ libraries with existing build systems:

### CMake Projects

Wrap `cmake` and `make` with `emcmake` and `emmake`:

```bash
mkdir -p build && cd build
emcmake cmake .. -DCMAKE_BUILD_TYPE=Release
emmake make
```

### Autoconf / Make Projects

Use `emconfigure` to configure cross-compilation toolchain targets and disable
shared libraries:

```bash
emconfigure ./configure --host=wasm32-unknown-emscripten --disable-shared
emmake make
```
