import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'

import { INITIAL_RETRY_DELAY, withRetry, withTimeout } from '../promise'

describe('withRetry', () => {
  describe('basic functionality', () => {
    it('should return result on successful first attempt', async () => {
      const operation = mock(() => Promise.resolve('success'))

      const result = await withRetry(operation)

      expect(result).toBe('success')
      expect(operation).toHaveBeenCalledTimes(1)
    })

    it('should retry on retryable error and succeed', async () => {
      let attempts = 0
      const operation = mock(() => {
        attempts++
        if (attempts === 1) {
          const error = { type: 'APIConnectionError' }
          return Promise.reject(error)
        }
        return Promise.resolve('success after retry')
      })

      // Mock setTimeout to avoid delays
      const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(
        ((callback: () => void) => {
          callback()
          return 0 as unknown as NodeJS.Timeout
        }) as typeof setTimeout,
      )

      const result = await withRetry(operation)

      expect(result).toBe('success after retry')
      expect(attempts).toBe(2)

      setTimeoutSpy.mockRestore()
    })

    it('should throw immediately on non-retryable error', async () => {
      const error = new Error('non-retryable')
      const operation = mock(() => Promise.reject(error))

      await expect(withRetry(operation)).rejects.toThrow('non-retryable')
      expect(operation).toHaveBeenCalledTimes(1)
    })

    it('should throw after max retries exceeded', async () => {
      const error = { type: 'APIConnectionError' }
      const operation = mock(() => Promise.reject(error))

      // Mock setTimeout to avoid delays
      const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(
        ((callback: () => void) => {
          callback()
          return 0 as unknown as NodeJS.Timeout
        }) as typeof setTimeout,
      )

      await expect(
        withRetry(operation, { maxRetries: 3 }),
      ).rejects.toMatchObject({ type: 'APIConnectionError' })

      expect(operation).toHaveBeenCalledTimes(3)

      setTimeoutSpy.mockRestore()
    })
  })

  describe('jitter behavior', () => {
    let setTimeoutSpy: ReturnType<typeof spyOn>
    let mathRandomSpy: ReturnType<typeof spyOn>
    let capturedDelays: number[]

    beforeEach(() => {
      capturedDelays = []

      // Capture the delay values passed to setTimeout
      setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(
        ((callback: () => void, delay: number) => {
          capturedDelays.push(delay)
          callback()
          return 0 as unknown as NodeJS.Timeout
        }) as typeof setTimeout,
      )
    })

    afterEach(() => {
      setTimeoutSpy.mockRestore()
      if (mathRandomSpy) {
        mathRandomSpy.mockRestore()
      }
    })

    it('should apply minimum jitter (0.8x) when Math.random returns 0', async () => {
      mathRandomSpy = spyOn(Math, 'random').mockReturnValue(0)

      const error = { type: 'APIConnectionError' }
      let attempts = 0
      const operation = mock(() => {
        attempts++
        if (attempts < 3) {
          return Promise.reject(error)
        }
        return Promise.resolve('success')
      })

      await withRetry(operation, {
        maxRetries: 3,
        retryDelayMs: INITIAL_RETRY_DELAY,
      })

      // With Math.random() = 0, jitter = 0.8
      // Attempt 0 (first retry): baseDelay = 1000 * 2^0 = 1000, delay = 1000 * 0.8 = 800
      // Attempt 1 (second retry): baseDelay = 1000 * 2^1 = 2000, delay = 2000 * 0.8 = 1600
      expect(capturedDelays).toEqual([800, 1600])
    })

    it('should apply maximum jitter (1.2x) when Math.random returns 1', async () => {
      mathRandomSpy = spyOn(Math, 'random').mockReturnValue(1)

      const error = { type: 'APIConnectionError' }
      let attempts = 0
      const operation = mock(() => {
        attempts++
        if (attempts < 3) {
          return Promise.reject(error)
        }
        return Promise.resolve('success')
      })

      await withRetry(operation, {
        maxRetries: 3,
        retryDelayMs: INITIAL_RETRY_DELAY,
      })

      // With Math.random() = 1, jitter = 1.2
      // Attempt 0: baseDelay = 1000 * 2^0 = 1000, delay = 1000 * 1.2 = 1200
      // Attempt 1: baseDelay = 1000 * 2^1 = 2000, delay = 2000 * 1.2 = 2400
      expect(capturedDelays).toEqual([1200, 2400])
    })

    it('should apply no jitter (1.0x) when Math.random returns 0.5', async () => {
      mathRandomSpy = spyOn(Math, 'random').mockReturnValue(0.5)

      const error = { type: 'APIConnectionError' }
      let attempts = 0
      const operation = mock(() => {
        attempts++
        if (attempts < 3) {
          return Promise.reject(error)
        }
        return Promise.resolve('success')
      })

      await withRetry(operation, {
        maxRetries: 3,
        retryDelayMs: INITIAL_RETRY_DELAY,
      })

      // With Math.random() = 0.5, jitter = 0.8 + 0.5 * 0.4 = 1.0
      // Attempt 0: baseDelay = 1000, delay = 1000 * 1.0 = 1000
      // Attempt 1: baseDelay = 2000, delay = 2000 * 1.0 = 2000
      expect(capturedDelays).toEqual([1000, 2000])
    })

    it('should apply exponential backoff with jitter correctly', async () => {
      // Use a specific random value to verify the jitter calculation
      mathRandomSpy = spyOn(Math, 'random').mockReturnValue(0.25)

      const error = { type: 'APIConnectionError' }
      let attempts = 0
      const operation = mock(() => {
        attempts++
        if (attempts < 4) {
          return Promise.reject(error)
        }
        return Promise.resolve('success')
      })

      await withRetry(operation, {
        maxRetries: 4,
        retryDelayMs: 1000,
      })

      // With Math.random() = 0.25, jitter = 0.8 + 0.25 * 0.4 = 0.9
      // Attempt 0: 1000 * 2^0 * 0.9 = 900
      // Attempt 1: 1000 * 2^1 * 0.9 = 1800
      // Attempt 2: 1000 * 2^2 * 0.9 = 3600
      expect(capturedDelays).toEqual([900, 1800, 3600])
    })

    it('should produce delays within ±20% of base delay', async () => {
      // Don't mock Math.random - let it use real random values
      mathRandomSpy?.mockRestore()

      const error = { type: 'APIConnectionError' }
      let attempts = 0
      const operation = mock(() => {
        attempts++
        if (attempts < 3) {
          return Promise.reject(error)
        }
        return Promise.resolve('success')
      })

      await withRetry(operation, {
        maxRetries: 3,
        retryDelayMs: 1000,
      })

      // Verify delays are within expected ranges
      // Attempt 0: base = 1000, range = [800, 1200]
      expect(capturedDelays[0]).toBeGreaterThanOrEqual(800)
      expect(capturedDelays[0]).toBeLessThanOrEqual(1200)

      // Attempt 1: base = 2000, range = [1600, 2400]
      expect(capturedDelays[1]).toBeGreaterThanOrEqual(1600)
      expect(capturedDelays[1]).toBeLessThanOrEqual(2400)
    })

    it('should use custom retryDelayMs for base delay calculation', async () => {
      mathRandomSpy = spyOn(Math, 'random').mockReturnValue(0.5) // jitter = 1.0

      const error = { type: 'APIConnectionError' }
      let attempts = 0
      const operation = mock(() => {
        attempts++
        if (attempts < 2) {
          return Promise.reject(error)
        }
        return Promise.resolve('success')
      })

      await withRetry(operation, {
        maxRetries: 2,
        retryDelayMs: 500, // Custom base delay
      })

      // With jitter = 1.0 and retryDelayMs = 500
      // Attempt 0: 500 * 2^0 * 1.0 = 500
      expect(capturedDelays).toEqual([500])
    })
  })

  describe('onRetry callback', () => {
    it('should call onRetry with error and attempt number', async () => {
      const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(
        ((callback: () => void) => {
          callback()
          return 0 as unknown as NodeJS.Timeout
        }) as typeof setTimeout,
      )

      const onRetry = mock(() => {})
      const error = { type: 'APIConnectionError' }
      let attempts = 0
      const operation = mock(() => {
        attempts++
        if (attempts < 3) {
          return Promise.reject(error)
        }
        return Promise.resolve('success')
      })

      await withRetry(operation, {
        maxRetries: 3,
        onRetry,
      })

      expect(onRetry).toHaveBeenCalledTimes(2)
      expect(onRetry).toHaveBeenNthCalledWith(1, error, 1)
      expect(onRetry).toHaveBeenNthCalledWith(2, error, 2)

      setTimeoutSpy.mockRestore()
    })
  })

  describe('retryIf callback', () => {
    it('should use custom retryIf to determine retryability', async () => {
      const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(
        ((callback: () => void) => {
          callback()
          return 0 as unknown as NodeJS.Timeout
        }) as typeof setTimeout,
      )

      let attempts = 0
      const operation = mock(() => {
        attempts++
        if (attempts === 1) {
          return Promise.reject({ code: 'RETRY_ME' })
        }
        return Promise.resolve('success')
      })

      const result = await withRetry(operation, {
        maxRetries: 3,
        retryIf: (error) => error?.code === 'RETRY_ME',
      })

      expect(result).toBe('success')
      expect(attempts).toBe(2)

      setTimeoutSpy.mockRestore()
    })

    it('should not retry when retryIf returns false', async () => {
      const error = { code: 'DO_NOT_RETRY' }
      const operation = mock(() => Promise.reject(error))

      await expect(
        withRetry(operation, {
          maxRetries: 3,
          retryIf: (err) => err?.code === 'RETRY_ME',
        }),
      ).rejects.toMatchObject({ code: 'DO_NOT_RETRY' })

      expect(operation).toHaveBeenCalledTimes(1)
    })
  })
})

describe('withTimeout', () => {
  it('should resolve when the promise finishes before the timeout', async () => {
    await expect(
      withTimeout(Promise.resolve('ok'), 100, 'too slow'),
    ).resolves.toBe('ok')
  })

  it('should reject when the promise exceeds the timeout', async () => {
    const neverResolves = new Promise<string>(() => {})

    await expect(withTimeout(neverResolves, 1, 'too slow')).rejects.toThrow(
      'too slow',
    )
  })

  it('should clear the timeout when the wrapped promise rejects first', async () => {
    let clearedTimeout: ReturnType<typeof setTimeout> | null = null
    const originalClearTimeout = globalThis.clearTimeout
    const clearTimeoutSpy = spyOn(globalThis, 'clearTimeout').mockImplementation(
      ((timeout: ReturnType<typeof setTimeout>) => {
        clearedTimeout = timeout
        return originalClearTimeout(timeout)
      }) as typeof clearTimeout,
    )

    try {
      await expect(
        withTimeout(Promise.reject(new Error('failed first')), 100, 'too slow'),
      ).rejects.toThrow('failed first')

      expect(clearedTimeout).not.toBeNull()
    } finally {
      clearTimeoutSpy.mockRestore()
    }
  })
})
