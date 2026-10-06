import { memo, type ReactNode } from 'react'

interface ErrorBoundaryPlaceholderProps {
  children: ReactNode
  fallback: ReactNode
  componentName?: string
}

/**
 * **WARNING: This component does NOT catch render errors.**
 * 
 * This is a placeholder/passthrough component that exists for structural purposes.
 * OpenTUI's JSX types don't support React class components, which are required
 * for true error boundary functionality.
 * 
 * For actual error catching in render functions, use `withErrorFallback()` instead.
 * 
 * @example
 * // Use withErrorFallback for catching render errors:
 * const safeContent = withErrorFallback(
 *   () => riskyRenderFunction(),
 *   <FallbackComponent />,
 *   'MyComponent'
 * )
 */
export const ErrorBoundaryPlaceholder = memo(
  ({ children }: ErrorBoundaryPlaceholderProps) => {
    // This component does NOT catch errors - it's a passthrough.
    // Use withErrorFallback() for actual error catching.
    return <>{children}</>
  },
)

/**
 * Helper to safely render content with error handling.
 * Use this when you need to catch render errors in a functional context.
 */
export function withErrorFallback<T>(
  renderFn: () => T,
  fallback: T,
  componentName?: string,
): T {
  try {
    return renderFn()
  } catch (error) {
    console.error(`[${componentName ?? 'withErrorFallback'}] Error caught:`, error)
    return fallback
  }
}
