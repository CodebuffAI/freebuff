# Language Model

The Prompt API allows developers to run natural language processing tasks directly in the browser using **Gemini Nano**. This built-in AI approach ensures user privacy, reduces server costs, and enables offline functionality.

## 1. Getting Started and Hardware Requirements

The Prompt API is currently available in Chrome as of version 148 (Desktop) for Windows, macOS, Linux, and Chromebook Plus.

### Hardware Prerequisites

- **Storage**: 22 GB free space (for the initial profile and model).
- **Memory/CPU**: 16 GB RAM and 4+ CPU cores.
- **GPU**: 4 GB VRAM or more (Required for audio input).
- **Network**: Required only for the initial model download.

### Initializing the API

**User Gesture Requirement:** When `availability()` returns `'downloadable'` or `'downloading'`, `LanguageModel.create()` starts the download and needs a user gesture, such as a button click. Call it from an event listener, not on page load, or it rejects with a `NotAllowedError`.

Check model availability before triggering a download:

```javascript
const availability = await LanguageModel.availability();

function createSession() {
	return LanguageModel.create({
		monitor(m) {
			// Inform the user while the model downloads so the UI doesn't appear frozen.
			m.addEventListener('downloadprogress', (e) => {
				console.log(`Downloaded ${e.loaded * 100}%`);
				progressEl.value = e.loaded; // a <progress max="1"> with an accessible name
			});
		},
	});
}

// Do not call create() when unavailable — the model cannot run on this device.
if (availability === 'available') {
	const session = await createSession();
} else if (availability !== 'unavailable') {
	// Starting the download requires a user gesture.
	downloadButton.addEventListener('click', async () => {
		const session = await createSession();
		downloadStatusEl.textContent = 'Model downloaded'; // a polite live region
	});
}
```

Show the download progress in a `<progress>` element with an accessible name, not only in the console, and announce when the download finishes in a polite live region (WCAG 4.1.3 Status Messages). If the button that starts the download is hidden while it has focus, move focus to the download's status text (give it `tabindex="-1"`) (WCAG 2.4.3 Focus Order).

## 2. Core Prompting Capabilities

Session examples in this section omit `session.destroy()` for brevity. Always call `session.destroy()` when a session is no longer needed to free device memory (see Section 5).

### Basic and Streamed Output

For short responses, use `prompt()`. For longer content, use `promptStreaming()` to provide a more responsive UI.

**MANDATORY**: Never assign model output to `innerHTML`. Model output is untrusted and can contain injected markup. Always use `textContent` or a sanitizer.

```javascript
const session = await LanguageModel.create();

// prompt() accumulates the full response before resolving — use for short, one-shot output.
const result = await session.prompt('Write a haiku about coding.');
// textContent, not innerHTML — model output is untrusted and must not be parsed as markup.
outputEl.textContent = result;

// promptStreaming() yields independent chunks that must be concatenated;
// use for longer content so each chunk can be rendered progressively.
const stream = session.promptStreaming('Write a long story about a robot.');
let completeResult = '';
outputEl.setAttribute('aria-busy', 'true'); // outputEl: <div aria-live="polite">
try {
	for await (const chunk of stream) {
		completeResult += chunk;
		outputEl.append(chunk);
	}
} finally {
	outputEl.setAttribute('aria-busy', 'false');
}
console.log('Full story:', completeResult);
```

Make the element that receives the output a polite live region that is in the page from page load, and set `aria-busy="true"` on it while a response streams in, so assistive technologies announce the complete response rather than each chunk (WCAG 4.1.3 Status Messages). Don't move focus while it streams in.

**MANDATORY:** If the output language differs from the page language, set `lang` on the output element to the language declared in `expectedOutputs`, so screen readers pronounce it correctly (WCAG 3.1.2 Language of Parts).

### Multimodal Input

The Prompt API supports text, audio, and visual inputs (images, canvas, video frames).

```javascript
const session = await LanguageModel.create({
	// Declaring expected input types lets the browser optimize model loading.
	expectedInputs: [{ type: 'text' }, { type: 'image' }],
	expectedOutputs: [{ type: 'text' }],
});

const response = await session.prompt([
	{
		role: 'user',
		content: [
			{ type: 'text', value: 'What is in this image?' },
			{ type: 'image', value: document.querySelector('canvas') },
		],
	},
]);
```

## 3. Advanced Session Management

Sessions allow the model to maintain context across multiple interactions.

### Context and Quota

Each session has a maximum token limit. You can monitor usage via `session.contextUsage` and `session.contextWindow`. If the window overflows, the oldest messages (except the system prompt) are dropped.

### Cloning Sessions

Cloning is efficient for starting parallel conversations that share the same initial context (like a "system" personality) without re-initializing.

```javascript
const mainSession = await LanguageModel.create({
	initialPrompts: [{ role: 'system', content: 'You speak like a pirate.' }],
});

const branchA = await mainSession.clone();
const branchB = await mainSession.clone();

// Run independent tasks on each clone, then destroy the clones when done.
await branchA.prompt('Greet the crew.');
branchA.destroy();

await branchB.prompt('Chart a course.');
branchB.destroy();

// Keep mainSession if you plan to clone it again later, or destroy it once no more clones are needed.
mainSession.destroy();
```

### Restoring Past Sessions

While a native "restore" feature is in development, you can recreate a session by feeding previous history into `initialPrompts`.

**Note**: `localStorage` is unencrypted and persistent. Stored conversation history may include user PII — consider the privacy implications before persisting chat history.

```javascript
// || '[]' ensures JSON.parse never receives null when the key doesn't exist yet.
const history = JSON.parse(localStorage.getItem('chat_history') || '[]');
const session = await LanguageModel.create({
	initialPrompts: history, // Array of {role, content} objects
});
```

## 4. Structured Output with JSON Schema

To prevent the model from adding "chatter" (e.g., "Sure, here is your JSON:"), use a **JSON Schema** via the `responseConstraint` field. This ensures the output is valid JSON that can be parsed immediately.

### Example: Sentiment Classification

```javascript
// Pass the schema as a plain object — do not JSON.stringify() it first.
const schema = {
	type: 'object',
	properties: {
		rating: { type: 'number', minimum: 1, maximum: 5 },
		is_positive: { type: 'boolean' },
	},
	required: ['rating', 'is_positive'],
};

const result = await session.prompt(
	"Rate the following feedback: 'The food was great!'",
	{ responseConstraint: schema },
);

const data = JSON.parse(result);
console.log(data.rating); // 5
```

### Constraints and Prefixes

You can guide the model further by prefilling the assistant's response using `prefix: true`.

````javascript
const character = await session.prompt([
	{ role: 'user', content: 'Create a character sheet' },
	{ role: 'assistant', content: '```json\n', prefix: true },
]);
````

## 5. Best Practices and Safety

- **Resource Cleanup**: Always call `session.destroy()` when a conversation is finished to free up memory.
- **Output Safety**: Model output is untrusted. Always write results to `textContent`, not `innerHTML`, to prevent XSS injection from malicious model output.
- Use a sanitizer like the native Sanitizer API or DOMPurify if you need to allow limited HTML.
- **Aborting Tasks**: Use `AbortController` to allow users to stop long-running generations. Pass the `signal` to `prompt()` or `promptStreaming()`, not to `LanguageModel.create()`. If the stop button is hidden while it has focus, move focus to the control that started the generation (WCAG 2.4.3 Focus Order).
- **Error Handling**: `create()`, `prompt()`, `promptStreaming()` and `JSON.parse()` can all fail, so wrap them, and the loop that reads a stream, in `try`/`catch`, and show a plain-language error in the output's live region (WCAG 3.3.1 Error Identification). Treat the `AbortError` from a user's stop as expected, not as an error.
- **Security**: Use Permission Policies to control access in iframes: `<iframe src="..." allow="language-model"></iframe>`.
- **Design**: Review the [People + AI Guidebook](https://pair.withgoogle.com/guidebook/) to ensure responsible AI implementation.

By combining structured outputs with robust session management, developers can build complex, stateful AI applications that run entirely on the user's device.

### Dos and Don'ts

For the full detailed list of dos and don'ts, see https://developer.chrome.com/docs/ai/built-in-ai-dos-donts.md.txt. Below is the gist:

#### Prepare the model at a reasonable time

*Applies to: all APIs, for example, Summarizer, Translator, and Writer.*

**Do:** Initialize the session as soon as you've clearly established the user's intention to use the AI feature, for example, when a user navigates into a relevant AI tools surface, hovers over an AI workspace, or interacts with the feature's surrounding UI. Pre-warming the session allows the model to load into memory quietly in the background while the user is setting up their task, eliminating avoidable cold-start latency.
Try to be one step ahead by starting the next most likely AI task as soon as you start rendering the current result, for example, if the feature is designed for iterative use.

**Don't:** Unless necessary, don't wait for the user to click "Generate" to initialize the session. This leads to a cold start delay, because the model must first load into memory and prepare its execution pipeline.

> [!CAUTION]
> For the Prompt API, wait until you have the `initialPrompts` ready before calling `create()`, because these can only be set during session creation.

#### Set initial prompts during creation

*Applies to: Prompt API.*

**Do:** Provide system instructions during session initialization to improve the
speed of the first prompt.

**Don't:** Start with an empty session and send system instructions as part of
the first `prompt()` call. This increases latency because it forces the model to
process those instructions at the last moment.

#### Clone sessions for repetitive tasks

*Applies to: Prompt API.*

For the Prompt API, each session [tracks the context of the
conversation](https://developer.chrome.com/docs/ai/prompt-api?content_ref=each+session+keeps+track+of+the+context+of+the+conversation+previous+interactions+are+taken+into+account+for+future+interactions+until+the+session+s+context+window+is+full),
taking all previous interactions into account. Because a clone inherits
everything from its parent session, including initial prompts and all
interaction history up to the point of cloning, structure your usage to inherit
only what you need.

**Do:**

- Create a base session: To handle unrelated tasks efficiently, create a base session that contains only your system instructions and no previous conversational context.
- Clone the baseline: Use `clone()` on that base session for new tasks to save the overhead of re-parsing system instructions. This lets you create parallel conversations or reset a task to its baseline.

**Don't:**

- Don't reuse the same session for unrelated tasks, and avoid cloning any session that already contains unnecessary interaction history. Both patterns can cause unrelated previous context to interfere with your current task.
- Don't repeatedly call `create()` with identical system instructions. Use the cloning pattern instead to optimize performance.

#### Destroy unused sessions

*Applies to: All APIs.*

**Do:** Explicitly call [`destroy()`](https://developer.chrome.com/docs/ai/prompt-api#terminate_a_session) on
sessions that you no longer need, to free up memory when a feature
is no longer in use. If you use a cloning pattern, keep the base session while
you still need to create new clones, destroy each cloned session as soon as its
task finishes, and destroy the base session once no further clones are needed.

**Don't:** Keep multiple large sessions active. Each session consumes memory,
which creates unnecessary resource usage and might become a problem. Sessions
will be naturally cleaned up by the garbage collector, but calling `destroy()`
frees up memory more quickly.

#### Render streaming responses safely and efficiently

*Applies to: All APIs with streaming support (Prompt, Summarizer, Writer,
Rewriter, and Translator).*

**Do:** Treat all LLM output as untrusted content. Sanitize the full combined
output, not just chunks, because malicious code could be split across updates.
Before rendering, use the [Sanitizer
API](https://developer.mozilla.org/docs/Web/API/HTML_Sanitizer_API) where
supported. To avoid a decrease in performance, use a streaming Markdown parser
like [streaming-markdown](https://github.com/thetarnav/streaming-markdown).

**Don't:** Directly set `innerHTML` on every chunk update. This is slow,
especially with complex formatting like syntax highlighting, and vulnerable to
injection.

#### Optimize input for speed

*Applies to: All APIs.*

**Do:** Only pass to the model what's strictly needed. Strip everything that's
irrelevant to the task at hand. For large datasets, provide a short overview and
a small selection of relevant items.

**Don't:** Send raw unprocessed text, unnecessary metadata, HTML tags, or large
unfiltered lists to the APIs. Latency grows significantly with input size, which
can make the AI feature seem broken on many devices.

#### Use structured output for predictable results

*Applies to: Prompt API.*

**Do:** When you need the model to return data in a specific format, use
[structured
output](https://developer.chrome.com/docs/ai/structured-output-for-prompt-api?content_ref=he+prompt+api+lets+you+specify+a+json+output+format+of+the+model+s+response+by+passing+a+json+schema+to+the+languagemodel+prompt+and+languagemodel+promptstreaming+methods)
by providing a `responseConstraint` field to provide a JSON Schema. This ensures
the output is predictable and prevents you from needing complex post-processing
or manual parsing.

**Don't:** Rely on natural language instructions (like "output only JSON")
alone. Models might include conversational filler that breaks your parser.

#### Decouple generation from length constraints

*Applies to: Prompt API, as it's the only API that supports [structured output
schemas](https://developer.chrome.com/docs/ai/structured-output-for-prompt-api).*

**Do:** Let the model generate its response naturally, and then use client-side
logic to truncate the text to fit your UI.

**Don't:** Enforce strict character limits like `maxLength: 125` using
[structured output schemas](https://developer.chrome.com/docs/ai/structured-output-for-prompt-api). When a
model's response is longer than the limit you set, the model might switch to
high-density tokens like foreign languages or emoji to compress meaning,
resulting in nonsensical output.

#### Keep the user informed

*Applies to: All APIs.*

**Do:** Depending on the complexity and expected duration of the task, use animations, visual cues, and progress indicators to keep the user informed. The
optimal approach depends on your use case and the expected length of the API
output. Some ideas:

- Streaming for long content: For summaries or chat, streaming creates a per-token typewriter effect by default. This can feel natural and provide immediate feedback.
- Non-streaming for short tasks (or long async tasks): For short outputs, for example, alt-text, non-streaming can create a more polished UI. It also provides time to speculatively prepare the next AI task while the current one renders. This approach also works for longer asynchronous or background tasks. If the user is not blocked on the output to continue their journey, there is no urgent need to produce the output as it happens. Signal that the process is ongoing in the UI.
- Visual transitions for updates: When translating or rewriting text, use animations, for example, word-morphing. For respecting reduced-motion preferences, see `motion` (via `npx -y modern-web-guidance@latest retrieve "motion"`).

**Don't:** Update the UI without visual cues, or without announcing the update to assistive technology users.

#### Align with the user's mental model of time and work

*Applies to: All APIs.*

**Do:** Consider an artificial delay of one or two seconds if a response is
nearly instant. Paradoxically, users might find results more trustworthy when
they perceive a generation process that aligns with their perceived difficulty
of the task. Use animations to signal that an AI process has occurred.

**Don't:** Surprise users with instant UI replacements.

#### Allow users to quickly navigate and undo AI edits

*Applies to: All APIs.*

**Do:** Equip your UI with a stepper or navigation history that lets users
explore different results confidently, and let them quickly undo AI edits. This
ensures that different versions are still readily available.

**Don't:** Overwrite the user's previous draft, or an AI result they might have
liked without a way to go back, revert, or compare versions.

#### Empower user control and overrides

*Applies to: All APIs.*

**Do:** Make the user the final editor of all generated content. Provide intuitive overrides so the user maintains full ownership for the final output. The APIs may produce incorrect results.

**Don't:** Force an AI-generated result as the only option.

#### Cache results for repeated tasks

*Applies to: All APIs.*

**Do:** Implement a local result cache (for example, using `sessionStorage` or
`IndexedDB`) for repeated inputs or queries. Normalize the input by trimming
whitespace and lowercasing to increase cache hits. For heavy inputs, for
example, images, generate a hash to use as a cache key. Set a conservative
time to live (TTL) for your cache (or serve cached results while updating them
in the background). Let the user trigger a fresh inference if the result is
unsatisfying.

**Don't:** Re-run the same inference for a repeated search query or identical data input where variability isn't desirable, for example when a user navigates back and forth between search results.
This optimizes responsiveness and efficient use of local compute.

## 6. Fallback strategies

Browser support for LanguageModel: Limited availability.
Supported by: Chrome 148 (May 2026).
Unsupported in: Edge, Firefox, and Safari.

Before use, check if the LanguageModel object is available in the global scope:

```js
if ('LanguageModel' in self) {
  // The Prompt API is supported.
} else {
  // Execute fallback strategy
}
```

If the Prompt API is unsupported or availability checks return 'unavailable', you must gracefully fall back:

* Remote API Fallback: Redirect the detection request to a server endpoint or a cloud API (such as the Vertex AI Gemini API).
* Local API Fallback: Redirect the detection request to a local endpoint, for example, using Transformers.js. 
