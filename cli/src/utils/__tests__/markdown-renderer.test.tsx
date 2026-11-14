import { TextAttributes } from '@opentui/core'
import { describe, expect, test } from 'bun:test'
import React from 'react'

import {
  hasIncompleteCodeFence,
  renderMarkdown,
  renderStreamingMarkdown,
} from '../markdown-renderer'

type El = React.ReactElement<Record<string, unknown>>

const flattenNodes = (input: unknown): React.ReactNode[] => {
  const result: React.ReactNode[] = []

  const visit = (value: unknown): void => {
    if (value === null || value === undefined || typeof value === 'boolean') {
      return
    }

    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }

    if (React.isValidElement(value) && value.type === React.Fragment) {
      visit((value as El).props.children)
      return
    }

    result.push(value as React.ReactNode)
  }

  visit(input)
  return result
}

const flattenChildren = (value: unknown): React.ReactNode[] =>
  flattenNodes(value)

describe('markdown renderer', () => {
  test('renders bold and italic emphasis', () => {
    const output = renderMarkdown('Hello **bold** and *italic*!')
    const nodes = flattenNodes(output)

    expect(nodes[0]).toBe('Hello ')

    const bold = nodes[1] as El
    expect(bold.props.attributes).toBe(TextAttributes.BOLD)
    expect(flattenChildren(bold.props.children)).toEqual(['bold'])

    expect(nodes[2]).toBe(' and ')

    const italic = nodes[3] as El
    expect(italic.props.attributes).toBe(TextAttributes.ITALIC)
    expect(flattenChildren(italic.props.children)).toEqual(['italic'])

    expect(nodes[4]).toBe('!')
  })

  test('renders inline code with palette colors', () => {
    const output = renderMarkdown('Use `ls` to list files.')
    const nodes = flattenNodes(output)

    expect(nodes[0]).toBe('Use ')

    const inlineCode = nodes[1] as El
    expect(inlineCode.props.fg).toBe('#86efac')
    expect(inlineCode.props.bg).toBe('#0d1117')
    expect(flattenChildren(inlineCode.props.children)).toEqual([' ls '])

    expect(nodes[2]).toBe(' to list files.')
  })

  test('renders headings with color and bold attribute', () => {
    const output = renderMarkdown('# Heading One')
    const nodes = flattenNodes(output)

    const heading = nodes[0] as El
    expect(heading.props.attributes).toBe(TextAttributes.BOLD)
    expect(heading.props.fg).toBe('magenta')
    expect(flattenChildren(heading.props.children)).toEqual(['Heading One'])
  })

  test('renders inline emphasis inside headings without extra spacing', () => {
    const output = renderMarkdown(
      '# Other**.github/** - GitHub workflows and config',
    )
    const nodes = flattenNodes(output)

    const heading = nodes[0] as El
    const contents = flattenChildren(heading.props.children)

    expect(contents[0]).toBe('Other')

    const strong = contents[1] as El
    expect(strong.props.attributes).toBe(TextAttributes.BOLD)
    expect(flattenChildren(strong.props.children)).toEqual(['.github/'])

    expect(contents[2]).toBe(' - GitHub workflows and config')
  })

  test('renders blockquotes with prefix', () => {
    const output = renderMarkdown('> note')
    const nodes = flattenNodes(output)

    const prefixSpan = nodes[0] as El
    expect(prefixSpan.props.fg).toBe('gray')
    expect(flattenChildren(prefixSpan.props.children)).toEqual(['> '])

    const textSpan = nodes[1] as El
    expect(textSpan.props.fg).toBe('gray')
    expect(flattenChildren(textSpan.props.children)).toEqual(['note'])
  })

  test('renders lists with bullet markers', () => {
    const output = renderMarkdown('- first\n- second')
    const nodes = flattenNodes(output)

    const bulletSpans = nodes.filter(
      (node): node is El =>
        React.isValidElement(node) &&
        node.type === 'span' &&
        flattenChildren((node as El).props.children).join('') === '- ',
    )

    expect(bulletSpans).toHaveLength(2)
    bulletSpans.forEach((span) => expect(span.props.fg).toBe('white'))

    const textNodes = nodes
      .filter((node): node is string => typeof node === 'string')
      .map((value) => value.trim())
      .filter(Boolean)
    expect(textNodes).toContain('first')
    expect(textNodes).toContain('second')
  })

  test('renders markdown without closing code fence while streaming', () => {
    const content = '**done**\n```js\nconsole.log('
    const output = renderStreamingMarkdown(content)
    const nodes = flattenNodes(output)

    const boldNode = nodes.find(
      (node): node is El =>
        React.isValidElement(node) &&
        (node as El).props !== undefined &&
        (node as El).props.attributes === TextAttributes.BOLD,
    )

    expect(boldNode).toBeDefined()
    expect(flattenChildren(boldNode!.props.children)).toEqual(['done'])
    expect(nodes[nodes.length - 1]).toBe('```js\nconsole.log(')
  })

  test('a ``` run that opens no fence leaves the rest of the stream rendered', () => {
    for (const content of [
      'A.\n\n``` a`b\n\n**after**\n',
      'Then ``` alone in text.\n\n**after**\n',
      '~~~\n```\n~~~\n\n**after**\n',
    ]) {
      expect(hasIncompleteCodeFence(content)).toBe(false)
      expect(renderStreamingMarkdown(content)).toEqual(renderMarkdown(content))
    }
  })

  test('a fence nested in a list or quote is still open while streaming', () => {
    expect(hasIncompleteCodeFence('- item\n\n  ```ts\n  const a')).toBe(true)
    expect(hasIncompleteCodeFence('> ```\n> code')).toBe(true)
    expect(hasIncompleteCodeFence('````md\n```\ninner')).toBe(true)
    expect(hasIncompleteCodeFence('```\ncode\n```')).toBe(false)
  })

  test('renders strikethrough text with GFM', () => {
    const output = renderMarkdown('This is ~~deleted~~ text')
    const nodes = flattenNodes(output)

    expect(nodes[0]).toBe('This is ')

    const strikethrough = nodes[1] as El
    expect(strikethrough.props.attributes).toBe(TextAttributes.DIM)
    expect(flattenChildren(strikethrough.props.children)).toEqual(['deleted'])

    expect(nodes[2]).toBe(' text')
  })

  test('renders task lists with GFM', () => {
    const output = renderMarkdown('- [ ] Todo\n- [x] Done')
    const nodes = flattenNodes(output)

    const checkboxSpans = nodes.filter(
      (node): node is El =>
        React.isValidElement(node) &&
        node.type === 'span' &&
        (flattenChildren((node as El).props.children).join('') === '[ ] ' ||
          flattenChildren((node as El).props.children).join('') === '[x] '),
    )

    expect(checkboxSpans).toHaveLength(2)
  })

  test('renders tables with GFM', () => {
    const markdown = `| Name | Age |
| ---- | --- |
| John | 30  |
| Jane | 25  |`
    const output = renderMarkdown(markdown)
    const nodes = flattenNodes(output)

    // Check that table structure is rendered with box-drawing characters
    const textContent = nodes
      .map((node) => {
        if (typeof node === 'string') return node
        if (React.isValidElement(node)) {
          return flattenChildren((node as El).props.children).join('')
        }
        return ''
      })
      .join('')

    expect(textContent).toContain('Name')
    expect(textContent).toContain('Age')
    expect(textContent).toContain('John')
    expect(textContent).toContain('Jane')
    expect(textContent).toContain('30')
    expect(textContent).toContain('25')
    // Table uses box-drawing characters for borders
    expect(textContent).toContain('│')
    expect(textContent).toContain('─')
  })

  test('renders code fence followed by text with quotes correctly', () => {
    const markdown = `\`\`\`bash
# Start using it
codebuff "add a new feature to handle user authentication"
\`\`\``
    const output = renderMarkdown(markdown)
    const nodes = flattenNodes(output)

    // Get the text content from all nodes
    const textContent = nodes
      .map((node) => {
        if (typeof node === 'string') return node
        if (React.isValidElement(node)) {
          return flattenChildren((node as El).props.children).join('')
        }
        return ''
      })
      .join('')

    // Should contain the complete command text
    expect(textContent).toContain('# Start using it')
    expect(textContent).toContain(
      'codebuff "add a new feature to handle user authentication"',
    )

    // Should NOT have quotes concatenated with backticks
    expect(textContent).not.toContain('it"')
    expect(textContent).not.toContain('```"')
  })

  test('renders inline code followed by quotes correctly', () => {
    const markdown = 'Use `codebuff "fix bug"` to fix bugs.'
    const output = renderMarkdown(markdown)
    const nodes = flattenNodes(output)

    expect(nodes[0]).toBe('Use ')

    const inlineCode = nodes[1] as El
    expect(inlineCode.props.fg).toBe('#86efac')
    const inlineContent = flattenChildren(inlineCode.props.children).join('')
    expect(inlineContent).toContain('codebuff "fix bug"')

    expect(nodes[2]).toBe(' to fix bugs.')

    // Verify quotes are inside the inline code, not concatenated after
    expect(inlineContent).toMatch(/codebuff\s+"fix bug"/)
  })

  test('renders multiple code blocks with text between them', () => {
    const markdown = `First block:

\`\`\`js
console.log("hello")
\`\`\`

Middle text with "quotes"

\`\`\`js
console.log("world")
\`\`\``
    const output = renderMarkdown(markdown)
    const nodes = flattenNodes(output)

    const textContent = nodes
      .map((node) => {
        if (typeof node === 'string') return node
        if (React.isValidElement(node)) {
          return flattenChildren((node as El).props.children).join('')
        }
        return ''
      })
      .join('')

    // All content should be present
    expect(textContent).toContain('First block:')
    expect(textContent).toContain('console.log("hello")')
    expect(textContent).toContain('Middle text with "quotes"')
    expect(textContent).toContain('console.log("world")')

    // Verify no quote concatenation issues
    expect(textContent).not.toContain('```"')
    expect(textContent).not.toContain('"```')
  })

  test('renders code fence with command and quotes on same line', () => {
    const markdown = `\`\`\`bash
codebuff "implement feature" --verbose
\`\`\``
    const output = renderMarkdown(markdown)
    const nodes = flattenNodes(output)

    const textContent = nodes
      .map((node) => {
        if (typeof node === 'string') return node
        if (React.isValidElement(node)) {
          return flattenChildren((node as El).props.children).join('')
        }
        return ''
      })
      .join('')

    // Should preserve the complete command with quotes
    expect(textContent).toContain('codebuff "implement feature" --verbose')
    expect(textContent).not.toContain('```"')
  })

  test('renders inline code with special characters correctly', () => {
    const markdown = 'Run `git commit -m "fix: bug"` to commit.'
    const output = renderMarkdown(markdown)
    const nodes = flattenNodes(output)

    const inlineCode = nodes[1] as El
    const inlineContent = flattenChildren(inlineCode.props.children).join('')

    // Should preserve quotes and special characters within inline code
    expect(inlineContent).toContain('git commit -m "fix: bug"')
    expect(nodes[2]).toBe(' to commit.')
  })

  test('wraps table columns when content exceeds available width', () => {
    // Table with very long content that should be wrapped
    const markdown = `| ID | This is a very long column header that should wrap |
| -- | -------------------------------------------------- |
| 1  | This cell has extremely long content that definitely exceeds the width |`
    
    // Use a narrow codeBlockWidth to force wrapping
    const output = renderMarkdown(markdown, { codeBlockWidth: 50 })
    const nodes = flattenNodes(output)

    const textContent = nodes
      .map((node) => {
        if (typeof node === 'string') return node
        if (React.isValidElement(node)) {
          return flattenChildren((node as El).props.children).join('')
        }
        return ''
      })
      .join('')

    // Should NOT contain ellipsis - content wraps instead of truncating
    expect(textContent).not.toContain('…')
    // The short column content should be present
    expect(textContent).toContain('ID')
    expect(textContent).toContain('1')
    // Box-drawing characters should still be present
    expect(textContent).toContain('│')
    expect(textContent).toContain('─')
    // The full content should be present across wrapped lines
    expect(textContent).toContain('long')
    expect(textContent).toContain('header')
    expect(textContent).toContain('wrap')
    expect(textContent).toContain('extremely')
    expect(textContent).toContain('exceeds')
  })

  test('does not wrap table columns when content fits available width', () => {
    const markdown = `| Name | Age |
| ---- | --- |
| John | 30  |`
    
    // Use a wide codeBlockWidth so no wrapping is needed
    const output = renderMarkdown(markdown, { codeBlockWidth: 80 })
    const nodes = flattenNodes(output)

    const textContent = nodes
      .map((node) => {
        if (typeof node === 'string') return node
        if (React.isValidElement(node)) {
          return flattenChildren((node as El).props.children).join('')
        }
        return ''
      })
      .join('')

    // All content should be present in full
    expect(textContent).toContain('Name')
    expect(textContent).toContain('Age')
    expect(textContent).toContain('John')
    expect(textContent).toContain('30')
  })

  test('wraps and shows full content when table is too wide', () => {
    // Three columns of roughly equal width
    const markdown = `| Column One | Column Two | Column Three |
| ---------- | ---------- | ------------ |
| Value1     | Value2     | Value3       |`
    
    // Very narrow width to force significant wrapping
    const output = renderMarkdown(markdown, { codeBlockWidth: 30 })
    const nodes = flattenNodes(output)

    const textContent = nodes
      .map((node) => {
        if (typeof node === 'string') return node
        if (React.isValidElement(node)) {
          return flattenChildren((node as El).props.children).join('')
        }
        return ''
      })
      .join('')

    // Table structure should still be present
    expect(textContent).toContain('│')
    expect(textContent).toContain('┌')
    expect(textContent).toContain('└')
    // Full content should still be visible (wrapped, not truncated)
    expect(textContent).not.toContain('…')
    // All values should be present
    expect(textContent).toContain('Value1')
    expect(textContent).toContain('Value2')
    expect(textContent).toContain('Value3')
  })
})
