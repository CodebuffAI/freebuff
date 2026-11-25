# Translator

The **Translator API** allows developers to perform client-side text translation using built-in AI models in Chrome and Edge. This approach eliminates the need for cloud-based translation services for ephemeral content, reducing costs and improving privacy by keeping data on the user's device.

## Prerequisites & Requirements

### API Surface & Global Scope

- **MANDATORY:** Access the Translator API exclusively via the global `Translator` interface (`window.Translator` / `self.Translator`).
- **DO NOT** use or check the deprecated `window.ai.translator` namespace.

### Browser Support

- **Chrome:** Version 138+ (Desktop only).
- **Edge:** Version 148+ (Desktop only).
- **Not Supported:** Mobile (Android/iOS), Firefox, Safari.

### Hardware Requirements

To run Gemini Nano and associated models, the system needs:

- **Operating System:** Windows 10/11, macOS 13+, Linux, or ChromeOS (Chromebook
  Plus).
- **Storage:** At least **22 GB** free on the profile volume.
- **Memory/CPU:** 16 GB+ RAM and 4+ CPU cores.
- **GPU:** 4 GB+ VRAM (Mandatory for Prompt API with audio).
- **Network:** Required only for the initial download of language packs/models.

## Implementation & Code Samples

### 1. Checking Availability & Model Management

**Mandatory Options Passing:** You must pass the identical configuration options object containing `sourceLanguage` and `targetLanguage` to both `Translator.availability(options)` and `Translator.create(options)`.

**Recommended Progress Monitoring:** You should implement a monitor for model download progress by providing a `monitor(m)` callback to `Translator.create()` and adding a listener for the `downloadprogress` event, so the user can see model download progress.

**User Gesture Requirement:** When calling `availability(options)` returns `'downloadable'` or `'downloading'`, calling `Translator.create()` triggers the download of the language pack and **strictly requires a user gesture** (such as a button click) to prevent a `NotAllowedError`.

`Translator.availability(options)` returns one of four string statuses:

- `'available'`: The language pair model is already downloaded on the device and ready for immediate translation.
- `'downloadable'`: The language pair is supported, but the model needs to be downloaded. A user gesture is required to initiate `Translator.create()`.
- `'downloading'`: The language pack is currently in the process of downloading. Calling `Translator.create()` with a user gesture attaches to the download.
- `'unavailable'`: The language pair or device is not supported. Execute your fallback strategy.

```javascript
// Language pair options passed to both availability() and create()
const options = {
  sourceLanguage: 'es', // Example BCP 47 language code
  targetLanguage: 'fr', // Example BCP 47 language code
};

// 1. Check availability for the language pair
const availability = await Translator.availability(options);

if (availability === 'available') {
  // Model is ready immediately on device
  const translator = await Translator.create(options);
} else if (availability === 'downloadable' || availability === 'downloading') {
  // User gesture is strictly required before create() triggers or attaches to download
  document.getElementById('start-translation-btn').addEventListener('click', async () => {
    const translator = await Translator.create({
      ...options,
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => {
          console.log(`Downloaded ${Math.round(e.loaded * 100)}%`);
        });
      },
    });
  });
} else if (availability === 'unavailable') {
  // Language pair or hardware unsupported; execute fallback
  console.warn('Translation model is unavailable on this device.');
}
```

### 2. Executing Translations

The API supports both static and streaming responses. Always include download progress monitoring when instantiating the translator.

**Standard Translation:**

```javascript
// Default to including a progress monitor when creating translator
const translator = await Translator.create({
  sourceLanguage: 'en',
  targetLanguage: 'fr',
  monitor(m) {
    m.addEventListener('downloadprogress', (e) => {
      console.log(`Downloaded ${Math.round(e.loaded * 100)}%`);
    });
  },
});

const result = await translator.translate(
  'Where is the next bus stop, please?',
);
console.log(result);
// Output: "Où est le prochain arrêt de bus, s'il vous plaît ?"
```

**Streaming Translation (for long text):**

```javascript
const stream = translator.translateStreaming(longText);
for await (const chunk of stream) {
  console.log(chunk);
}
```

## Supported Languages

The API supports a wide range of BCP 47 language codes: Here are the languages supported by Chrome's implementation of the Translator API:

- **ar**: Arabic
- **bg**: Bulgarian
- **bn**: Bengali
- **cs**: Czech
- **da**: Danish
- **de**: German
- **el**: Greek
- **en**: English
- **es**: Spanish
- **fi**: Finnish
- **fr**: French
- **hi**: Hindi
- **hr**: Croatian
- **hu**: Hungarian
- **id**: Indonesian
- **it**: Italian
- **he**: Hebrew
- **ja**: Japanese
- **kn**: Kannada
- **ko**: Korean
- **lt**: Lithuanian
- **mr**: Marathi
- **nl**: Dutch
- **no**: Norwegian
- **pl**: Polish
- **pt**: Portuguese
- **ro**: Romanian
- **ru**: Russian
- **sk**: Slovak
- **sl**: Slovenian
- **sv**: Swedish
- **ta**: Tamil
- **te**: Telugu
- **th**: Thai
- **tr**: Turkish
- **uk**: Ukrainian
- **vi**: Vietnamese
- **zh**: Chinese
- **zh-Hant**: Chinese (Traditional)

## Accessibility considerations

**MANDATORY:** Apply the `lang` attribute to the container element for the translated content, and make sure that its value matches the BCP 47 language code for the target language, for example `lang="es"` for Spanish.

## Security & Performance

- **Permissions Policy:** Cross-origin iframes require explicit permission.

  ```html
  <iframe src="https://example.com/" allow="translator"></iframe>
  ```

- **Web Workers:** Currently **not supported** due to Permission Policy
  complexities.
- **Privacy:** No data is sent to Google servers during the translation process
  once the model is downloaded.

## Fallback Strategy

Browser support for Translator: Limited availability.
Supported by: Chrome 138 (Jun 2025) and Edge 148 (May 2026).
Unsupported in: Firefox and Safari.

Before use, check if the `Translator` object is available in the global scope:

```javascript
if ('Translator' in self) {
  // The Translator API is supported.
} else {
  // Execute fallback strategy (do not fall back to window.ai.translator).
}
```

If the `Translator` API is unsupported or availability checks return `'unavailable'`, you must gracefully fall back.

Recommended options:

1. **Remote API Fallback**: Redirect the translation request to a server endpoint or cloud remote API (such as the Vertex AI Gemini API) to deliver translation functionality.
2. **Graceful Degradation**: Visually disable translation control elements or buttons while showing an end-user friendly note (e.g., `"Client-side translation is currently unsupported in this browser"`). Do not allow unhandled exceptions.
3. **Polyfill Fallback**: You can use community-maintained polyfills like `built-in-ai-task-apis-polyfills` or `prompt-api-polyfill` to emulate the API surface using remote services.

> **Privacy and Cost Implications:** These polyfills possibly proxy requests to remote servers (such as Gemini API over the cloud), though local processing is an option, too. Remote processing completely nullifies the on-device privacy guarantees of the native Built-in AI APIs and will often incur server-side API usage costs.
