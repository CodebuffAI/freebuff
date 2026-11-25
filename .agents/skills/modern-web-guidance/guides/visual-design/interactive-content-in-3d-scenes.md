# Enable interactive HTML content in 3D scenes

The HTML-in-Canvas API allows rendering real DOM directly inside a canvas element. When applied to 3D rendering contexts like WebGL, WebGPU, or Three.js, adding the `content="drawable"` attribute to the canvas, and the `drawable` attribute to its descendant HTML elements, enables those elements to be seamlessly projected into the 3D scene. Crucially, because the HTML elements remain part of the active DOM layout tree, they retain full interactivity—allowing users to click buttons, select text, and trigger focus states natively without requiring complex raycasting or custom event handling.

## How to implement

### WebGL and WebGPU
When using WebGL or WebGPU, follow these steps:

1. Check if HTML-in-Canvas is supported in the browser:

```
if ('content' in HTMLCanvasElement.prototype) {
  // Use HTML in Canvas API
} else {
  // Use fallback strategy
}
```

2. Initialize `<canvas>` to support descendant HTML elements by adding the `content="drawable"` attribute to the `<canvas>` HTML element. Place your HTML content inside the `<canvas>` element, and add the `drawable` attribute to every element that you draw. An element with `drawable` captures its subtree, except nested descendants that are also `drawable`:

```html
<canvas id="canvas" content="drawable">
  <div id="html-content" drawable></div>
</canvas>
```

3. Scale your canvas grid to match the device scale factor to prevent blurriness:

```js
const observer = new ResizeObserver(([entry]) => {
  const dpc = entry.devicePixelContentBoxSize;
  canvas.width = dpc
    ? dpc[0].inlineSize
    : Math.round(entry.contentRect.width * window.devicePixelRatio);
  canvas.height = dpc
    ? dpc[0].blockSize
    : Math.round(entry.contentRect.height * window.devicePixelRatio);
});

const supportsDevicePixelContentBox =
  typeof ResizeObserverEntry !== "undefined" &&
  "devicePixelContentBoxSize" in ResizeObserverEntry.prototype;
const options = supportsDevicePixelContentBox
  ? { box: "device-pixel-content-box" }
  : {};
observer.observe(canvas, options);
```

4. Render the HTML content to a texture inside a `canvas.onpaint` event handler. An element can only be uploaded after the canvas has painted it: call `canvas.requestPaint()` to request a `paint` event.

Size the texture from `canvas.captureElementImage(element)`. Its `width` and `height` are in canvas grid (backing store) pixels, so round them up with `Math.ceil()`. `captureElementImage()` throws if the element has no paint record yet: call `requestPaint()`, and retry on the next `paint` event.

```js
// Returns the element's size in canvas grid pixels, or null if the element
// has no paint record yet.
function getElementImageSize(canvas, element) {
  let elementImage;
  try {
    elementImage = canvas.captureElementImage(element);
  } catch (err) {
    canvas.requestPaint(); // No paint record yet: retry on the next paint event.
    return null;
  }
  const width = Math.ceil(elementImage.width);
  const height = Math.ceil(elementImage.height);
  elementImage.close();
  return width > 0 && height > 0 ? { width, height } : null;
}
```

- In WebGL context, pre-allocate the texture backing first using the `texImage2D` method. The snippets in this guide use a WebGL 2 context (`canvas.getContext("webgl2")`). Allocate texture storage by calling `texImage2D()` with `null` instead of pixel data, which reserves GPU memory of the given size and format without uploading any pixels. Follow these rules:
  - Size the texture from `captureElementImage()`, as shown above.
  - Allocate level 0 only on the first upload, or when the size changes, because reallocating clears the texture. Use mutable storage: immutable `texStorage2D()` storage can't be resized when the element changes size.

```js
// Binds the texture, and allocates its storage on the first upload, and when
// the element size changes. `state` stores the allocated size.
function allocateElementTexture(gl, texture, state, width, height) {
  gl.bindTexture(gl.TEXTURE_2D, texture);
  if (state.width === width && state.height === height) return;

  gl.texImage2D(
    gl.TEXTURE_2D,
    0,                // Mipmap level
    gl.RGBA8,         // Internal format: 8 bits per RGBA channel
    width,            // Size in canvas grid pixels
    height,
    0,                // Border: must be 0
    gl.RGBA,          // Format and type that match RGBA8
    gl.UNSIGNED_BYTE,
    null              // null reserves GPU memory without uploading pixels
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  state.width = width;
  state.height = height;
}

const texture = gl.createTexture();
const textureState = { width: 0, height: 0 };
```

- Then, in WebGL context, render the HTML content to the texture using the `texElementSubImage2D` method. Follow these rules:
  - Pass `{ width, height }` in the config. It makes the copy fill the allocated texture regardless of how the canvas is scaled.
  - Reallocate the texture if the size changed, as shown above.

```js
// Uploads the element into the texture. Returns false if the element has no
// paint record yet. In that case, it's uploaded on the next paint event.
function uploadElementWebGL(gl, canvas, texture, element, state) {
  const size = getElementImageSize(canvas, element);
  if (!size) return false;
  const { width, height } = size;

  // Bind the texture, and reallocate it if the size changed (see above).
  allocateElementTexture(gl, texture, state, width, height);
  gl.texElementSubImage2D(gl.TEXTURE_2D, 0, 0, 0, element, { width, height });
  return true;
}

canvas.onpaint = () => {
  try {
    uploadElementWebGL(gl, canvas, texture, uiElement, textureState);
  } catch (err) {
    console.error('texElementSubImage2D copy failed:', err);
  }
};
```

- In WebGPU context, use the `drawElementImageToTexture` method. Follow these rules:
  - Create the texture with `COPY_DST` and `RENDER_ATTACHMENT` usage, and add `TEXTURE_BINDING` to sample it in shaders. A wrong usage is reported as a WebGPU validation error, not as an exception.
  - Pass the texture size as `size`. Without `size`, a larger element is clipped to the texture. With `size`, the element is scaled to fill it.
  - WebGPU textures can't be resized. Recreate the texture when the element size changes, and rebuild the bind groups that reference it.

```js
// WebGPU textures can't be resized. Create the texture once, and recreate it
// when the element size changes.
function ensureElementTexture(device, state, width, height) {
  if (state.texture?.width === width && state.texture?.height === height) {
    return state.texture;
  }
  state.texture?.destroy();
  state.texture = device.createTexture({
    size: { width, height },
    format: "rgba8unorm",
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.RENDER_ATTACHMENT,
  });
  return state.texture; // Recreate the bind groups that used the previous texture.
}

const textureState = { texture: null };

canvas.onpaint = () => {
  const size = getElementImageSize(canvas, uiElement);
  if (!size) return;
  const previousTexture = textureState.texture;
  const texture = ensureElementTexture(device, textureState, size.width, size.height);
  if (texture !== previousTexture) {
    // New texture: create, or rebuild, the bind groups that reference it.
  }
  try {
    device.queue.drawElementImageToTexture({ source: uiElement }, { texture, size });
  } catch (err) {
    console.error('drawElementImageToTexture copy failed:', err);
  }
};
```

When using a `requestAnimationFrame` loop to render the scene, call `canvas.requestPaint()` within the loop to ensure that the HTML content is rendered to the canvas. `event.changedElements` lists the elements whose rendering changed. Make sure you only re-upload the texture if there has been an update to the descendant HTML elements:

```js
function render() {
  // Request to update the canvas
  canvas.requestPaint();
  requestAnimationFrame(render);
}
requestAnimationFrame(render);

canvas.onpaint = (event) => {
  if (event.changedElements && event.changedElements.length > 0) {
    // Update the texture as shown above
  }
  // Render the scene, and sync the element geometry as shown in step 5
};
```

5. Sync the element geometry.

Compute a `DOMMatrix` that maps the element's border box, in CSS pixels, to the canvas, in CSS pixels. The browser needs to map from the 3D coordinate space into the CSS coordinate space using a viewport transform. To facilitate this, do the following:
  - Normalize the HTML element. HTML elements are sized in pixels (for example, 200px wide). WebGL, however, usually treats objects as "unit squares", for example, ranging from -0.5 to 0.5. If you don't normalize, your 200px button will look 200 times larger. This step also flips the Y-axis, because in CSS, down is positive, but in WebGL, up is positive.
  - Convert the WebGL MVP Matrix to a DOM Matrix.
  - Map to the canvas viewport. This step is the "re-scaling" phase: it stretches that unit-space math back out to match the CSS pixel dimensions of your `<canvas>` element on the screen, and flips the Y-axis back.
  - Calculate the final transform. Multiply the matrices in order: Viewport * MVP * Normalization. Combining them into one final transform produces a "map" that tells the browser exactly where that HTML element should sit to align with the 3D drawing. The browser performs the perspective divide.

  ```js
  // Maps the element's border box (CSS pixels) to the canvas (CSS pixels), for a
  // quad that spans -0.5 to 0.5 in model space and is drawn with the `mvp` matrix.
  function computeCanvasTransform(canvas, element, mvp) {
    const width = element.offsetWidth;
    const height = element.offsetHeight;

    // 1. Normalize the HTML element (CSS pixels -> WebGL Model Space)
    const toGLModel = new DOMMatrix()
      // Scale pixels to 1 unit, flip Y (as in CSS it points down, and in WebGL it points up)
      .scale(1 / width, -1 / height, 1 / height)
      // Center the origin: (0,0) becomes (-width/2, -height/2) before scaling
      .translate(-width / 2, -height / 2);

    // 2. Convert WebGL MVP Matrix to DOM Matrix
    const mvpDOM = new DOMMatrix(Array.from(mvp));

    // 3. Map to the canvas viewport, in CSS pixels
    const clipToCanvasViewport = new DOMMatrix()
      // Move center (0,0) to center of canvas
      .translate(canvas.clientWidth / 2, canvas.clientHeight / 2)
      // Scale normalized clip (-1..1) to viewport size, and flip Y back
      .scale(canvas.clientWidth / 2, -canvas.clientHeight / 2, canvas.clientHeight / 2);

    // 4. Multiply: (Clip -> Pixels) * (MVP) * (pixels -> unit square)
    return clipToCanvasViewport.multiply(mvpDOM).multiply(toGLModel);
  }
  ```

Then pass the transform to `canvas.updateElementGeometry()` as `canvasTransform`. This moves the HTML element to sit directly on top of its rendered pixels. This ensures that when a user clicks a button or selects text, they are actually hitting the real HTML element. The browser also uses the transform for the element's accessibility bounds, for example, for screen reader focus rings:

  ```js
  canvas.updateElementGeometry(targetHTMLElement, {
    canvasTransform: computeCanvasTransform(canvas, targetHTMLElement, htmlElementMVP),
  });
  ```

Use these options to control hit testing:
  - Each `updateElementGeometry()` call moves the element to the top of the hit-testing order. Pass `{ preserveHitTestOrder: true }` to keep its position.
  - Call `canvas.clearElementGeometry(element)` to remove an element from hit testing, for example, when you hide it.

### Three.js

1. Check if HTML-in-Canvas is supported in the browser:

```js
if ('content' in HTMLCanvasElement.prototype) {
  // Use HTML in Canvas API
} else {
  // Use fallback strategy
}
```

2. Create a custom geometry and material for the HTML content.

3. Pass the DOM element into THREE.HTMLTexture. The renderer adds the element to its canvas, and sets the required attributes:
```js
  material.map = new THREE.HTMLTexture(element);
  mesh = new THREE.Mesh( geometry, material );
  scene.add( mesh );
```

4. Register the mesh with `InteractionManager` to make the HTML element interactive. It keeps the element aligned with the mesh, and syncs the element geometry with the canvas, so that clicks and text selection hit the real HTML element. Call `interactions.update()` in the animation loop, before rendering:
```js
  import { InteractionManager } from 'three/addons/interaction/InteractionManager.js';

  const interactions = new InteractionManager();
  interactions.connect( renderer, camera );
  interactions.add( mesh );

  // In the animation loop
  interactions.update();
  renderer.render( scene, camera );
```

## Example code

### WebGL Canvas

```html
<canvas id="canvas" content="drawable" style="width: 400px; height: 400px;">
  <div id="ui-element" drawable>
    <p>WebGL UI Element</p>
    <button>Action</button>
  </div>
</canvas>

<script>
  const canvas = document.getElementById("canvas");
  const gl = canvas.getContext("webgl2");
  const uiElement = document.getElementById("ui-element");

  // getElementImageSize(), allocateElementTexture(), and uploadElementWebGL()
  // are defined in step 4.
  // computeCanvasTransform() is defined in step 5.

  // Setup WebGL texture...
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  const textureState = { width: 0, height: 0 };

  canvas.onpaint = () => {
    // 1. Update texture with HTML content
    try {
      uploadElementWebGL(gl, canvas, texture, uiElement, textureState);
    } catch (err) {
      console.error('texElementSubImage2D copy failed:', err);
    }

    // ... Render your 3D scene here, calculating htmlElementMVP matrix ...

    // 2. Sync DOM position, hit testing, and accessibility bounds with 3D scene
    canvas.updateElementGeometry(uiElement, {
      canvasTransform: computeCanvasTransform(canvas, uiElement, htmlElementMVP),
    });
  };
</script>
```

### WebGPU Canvas

```html
<canvas id="canvas" content="drawable" style="width: 400px; height: 400px;">
  <div id="ui-element" drawable>
    <p>WebGPU UI Element</p>
  </div>
</canvas>

<script>
  const canvas = document.getElementById("canvas");
  const context = canvas.getContext("webgpu");
  const uiElement = document.getElementById("ui-element");

  // getElementImageSize() and ensureElementTexture() are defined in step 4.
  // computeCanvasTransform() is defined in step 5.

  // Setup WebGPU...
  // const device = ...
  const textureState = { texture: null };

  canvas.onpaint = () => {
    // 1. Copy HTML content to a texture that matches the element size
    const size = getElementImageSize(canvas, uiElement);
    if (size) {
      const previousTexture = textureState.texture;
      const texture = ensureElementTexture(device, textureState, size.width, size.height);
      if (texture !== previousTexture) {
        // New texture: create, or rebuild, the bind groups that reference it.
      }
      try {
        device.queue.drawElementImageToTexture({ source: uiElement }, { texture, size });
      } catch (err) {
        console.error('drawElementImageToTexture copy failed:', err);
      }
    }

    // ... Render your 3D scene here, calculating htmlElementMVP matrix ...

    // 2. Sync DOM position, hit testing, and accessibility bounds (same matrix math as WebGL)
    canvas.updateElementGeometry(uiElement, {
      canvasTransform: computeCanvasTransform(canvas, uiElement, htmlElementMVP),
    });
  };
</script>
```

### Three.js

```js
// 1. Initialize Three.js camera, scene, renderer, mesh, interactions;

// 2. Ensure HTML-in-Canvas feature support
if (!('content' in HTMLCanvasElement.prototype)) {
  // Use a fallback strategy
}

// 3. Initialize the source HTML DOM element
const element = document.createElement('div');
element.innerHTML = '<h1>Hello World</h1>';

// 4. Create geometry and material
const geometry = new RoundedBoxGeometry( 100, 100, 100, 10, 10 );
const material = new THREE.MeshStandardMaterial( { roughness: 0, metalness: 0.5 } );

// 5. Pass the DOM element into THREE.HTMLTexture
material.map = new THREE.HTMLTexture(element);

mesh = new THREE.Mesh( geometry, material );
scene.add( mesh );

// 6. Make the HTML element interactive
interactions = new InteractionManager();
interactions.connect( renderer, camera );
interactions.add( mesh );

// 7. Render Loop
function animate() {
  // Keep the HTML element aligned with the mesh, so it receives input
  interactions.update();
  renderer.render(scene, camera);
}
```

## Best Practices

- **MANDATORY**: Check browser support for the HTML-in-Canvas API before using it.
- **MANDATORY**: When using WebGL or WebGPU, always add the `content="drawable"` attribute to the `<canvas>` element.
- **MANDATORY**: When using WebGL or WebGPU, add the `drawable` attribute to every element that you draw, including direct children of the canvas.
- **MANDATORY**: When using WebGL or WebGPU, use an `onpaint` event handler to render the HTML content to the canvas.
- **MANDATORY**: When using WebGL, pre-allocate the texture buffer with `texImage2D()` once (when it's initialized or when the element size changes). Reallocate the texture only when the size changes, and set `TEXTURE_MIN_FILTER` to `LINEAR`.
- **MANDATORY**: When using WebGL, use the `texElementSubImage2D` method to render the HTML content to a texture that you pre-allocate with `texImage2D()`, sized from `captureElementImage()`.
- **MANDATORY**: When using WebGPU, use the `drawElementImageToTexture` method to render the HTML content to the canvas. Size the texture from `captureElementImage()`, and recreate it only when the size changes. Create the texture with `COPY_DST` and `RENDER_ATTACHMENT` usage, and pass the texture size as `size`.
- **MANDATORY**: When using WebGL or WebGPU, sync the geometry of the HTML element with the rendered content by calling `canvas.updateElementGeometry(element, { canvasTransform })`.
- **MANDATORY**: When using Three.js, register the mesh with `InteractionManager`, and call `interactions.update()` in the animation loop, so the HTML element receives input.
- **MANDATORY**: Observe the screen size and update the canvas size to match device pixels, for example, by using `ResizeObserver`.
- **DO NOT** embed cross-origin content in a canvas, as it is not supported.
- **DO NOT** initialize `ResizeObserver` within the `onpaint` event handler, as it may lead to memory leaks.

### Fallback strategies

Browser support for HTML-in-canvas: Limited availability.
Supported by: Chrome 157 (Nov 2026) and Edge 157 (Nov 2026).
Unsupported in: Firefox and Safari.

The HTML-in-Canvas API is not currently supported in all modern browsers, thus a fallback strategy is typically required.

However, given the improved performance benefits of this API, HTML-in-Canvas should be used if the browser supports it.

The fallback strategy depends on the use case. For example, for an interactive HTML content in canvas, if HTML-in-Canvas is not supported, place the HTML content on top of the canvas using CSS.

### HTML-in-Canvas polyfill

Use the following polyfill script to mimic the HTML-in-Canvas API in browsers that do not support it.

1. Install or embed the library:

```
# Install
npm install three-html-render
```

```
# Embed
<script src="https://cdn.jsdelivr.net/npm/three-html-render/dist/polyfill.js"></script>
```

2. Run the `installHtmlInCanvasPolyfill()` method to translate HTML-in-Canvas.
