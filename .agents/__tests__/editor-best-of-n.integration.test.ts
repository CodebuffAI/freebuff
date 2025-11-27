import { API_KEY_ENV_VAR } from '@codebuff/common/old-constants'
import { describe, expect, it } from 'bun:test'

import { CodebuffClient } from '@codebuff/sdk'

import type { PrintModeEvent } from '@codebuff/common/types/print-mode'

/**
 * Integration tests for the editor-best-of-n-max agent.
 * These tests verify that the best-of-n editor workflow works correctly:
 * 1. Spawns multiple implementor agents in parallel
 * 2. Collects their implementation proposals
 * 3. Uses a selector agent to choose the best implementation
 * 4. Applies the chosen implementation
 */
describe('Editor Best-of-N Max Agent Integration', () => {
  it(
    'should generate and select the best implementation for a simple edit',
    async () => {
      const apiKey = process.env[API_KEY_ENV_VAR]
      if (!apiKey) {
        throw new Error('API key not found')
      }

      // Create mock project files with a simple TypeScript file to edit
      const projectFiles: Record<string, string> = {
        'src/utils/math.ts': `
export function add(a: number, b: number): number {
  return a + b
}

export function subtract(a: number, b: number): number {
  return a - b
}
`,
        'src/index.ts': `
import { add, subtract } from './utils/math'

console.log(add(1, 2))
console.log(subtract(5, 3))
`,
        'package.json': JSON.stringify({
          name: 'test-project',
          version: '1.0.0',
          dependencies: {},
        }),
      }

      const client = new CodebuffClient({
        apiKey,
        cwd: '/tmp/test-best-of-n-project',
        projectFiles,
      })

      const events: PrintModeEvent[] = []

      // Run the editor-best-of-n-max agent with a simple task
      // Using n=2 to keep the test fast while still testing the best-of-n workflow
      const run = await client.run({
        agent: 'editor-best-of-n-max',
        prompt:
          'Add a multiply function to src/utils/math.ts that takes two numbers and returns their product',
        params: { n: 2 },
        handleEvent: (event) => {
          console.log(event)
          events.push(event)
        },
      })

      // The output should not be an error
      expect(run.output.type).not.toEqual('error')

      // Verify we got some output
      expect(run.output).toBeDefined()

      // The output should contain the implementation response
      const outputStr =
        typeof run.output === 'string' ? run.output : JSON.stringify(run.output)
      console.log('Output:', outputStr)

      // Should contain evidence of the multiply function being added
      const relevantTerms = ['multiply', 'product', 'str_replace', 'write_file']
      const foundRelevantTerm = relevantTerms.some((term) =>
        outputStr.toLowerCase().includes(term.toLowerCase()),
      )

      expect(foundRelevantTerm).toBe(true)
    },
    { timeout: 120_000 }, // 2 minute timeout for best-of-n workflow
  )
})
