import { describe, expect, it } from 'bun:test'

import { tryToDoStringReplacementWithExtraIndentation } from '../generate-diffs-prompt'

describe('tryToDoStringReplacementWithExtraIndentation', () => {
  it('should return null when search content is found without extra indentation', () => {
    const oldFileContent = 'function foo() {\n  return 1;\n}\n'
    const searchContent = 'function foo() {\n  return 1;\n}\n'
    const replaceContent = 'function foo() {\n  return 2;\n}\n'

    const result = tryToDoStringReplacementWithExtraIndentation({
      oldFileContent,
      searchContent,
      replaceContent,
    })

    expect(result).toBeNull()
  })

  it('should match with extra space indentation', () => {
    const oldFileContent = '  function foo() {\n    return 1;\n  }\n'
    const searchContent = 'function foo() {\n  return 1;\n}\n'
    const replaceContent = 'function foo() {\n  return 2;\n}\n'

    const result = tryToDoStringReplacementWithExtraIndentation({
      oldFileContent,
      searchContent,
      replaceContent,
    })

    expect(result).not.toBeNull()
    expect(result!.searchContent).toBe(
      '  function foo() {\n    return 1;\n  }\n',
    )
    expect(result!.replaceContent).toBe(
      '  function foo() {\n    return 2;\n  }\n',
    )
  })

  it('should match with extra tab indentation', () => {
    const oldFileContent = '\tfunction foo() {\n\t\treturn 1;\n\t}\n'
    const searchContent = 'function foo() {\n\treturn 1;\n}\n'
    const replaceContent = 'function foo() {\n\treturn 2;\n}\n'

    const result = tryToDoStringReplacementWithExtraIndentation({
      oldFileContent,
      searchContent,
      replaceContent,
    })

    expect(result).not.toBeNull()
    expect(result!.searchContent).toBe(
      '\tfunction foo() {\n\t\treturn 1;\n\t}\n',
    )
    expect(result!.replaceContent).toBe(
      '\tfunction foo() {\n\t\treturn 2;\n\t}\n',
    )
  })

  it('should return null when content does not match with any indentation', () => {
    const oldFileContent = 'function foo() {\n  return 1;\n}\n'
    const searchContent = 'function bar() {\n  return 1;\n}\n'
    const replaceContent = 'function bar() {\n  return 2;\n}\n'

    const result = tryToDoStringReplacementWithExtraIndentation({
      oldFileContent,
      searchContent,
      replaceContent,
    })

    expect(result).toBeNull()
  })

  it('should not add indentation to empty lines', () => {
    const oldFileContent = '    const x = 1;\n\n    const y = 2;\n'
    const searchContent = 'const x = 1;\n\nconst y = 2;\n'
    const replaceContent = 'const x = 10;\n\nconst y = 20;\n'

    const result = tryToDoStringReplacementWithExtraIndentation({
      oldFileContent,
      searchContent,
      replaceContent,
    })

    expect(result).not.toBeNull()
    expect(result!.searchContent).toBe('    const x = 1;\n\n    const y = 2;\n')
    expect(result!.replaceContent).toBe(
      '    const x = 10;\n\n    const y = 20;\n',
    )
  })

  it('should find the smallest matching indentation level', () => {
    const oldFileContent = ' const x = 1;\n'
    const searchContent = 'const x = 1;\n'
    const replaceContent = 'const x = 2;\n'

    const result = tryToDoStringReplacementWithExtraIndentation({
      oldFileContent,
      searchContent,
      replaceContent,
    })

    expect(result).not.toBeNull()
    expect(result!.searchContent).toBe(' const x = 1;\n')
    expect(result!.replaceContent).toBe(' const x = 2;\n')
  })

  it('should return null when first line matches with indentation but subsequent lines mismatch', () => {
    const oldFileContent = '  function foo() {\n    return 999;\n  }\n'
    const searchContent = 'function foo() {\n  return 1;\n}\n'
    const replaceContent = 'function foo() {\n  return 2;\n}\n'

    const result = tryToDoStringReplacementWithExtraIndentation({
      oldFileContent,
      searchContent,
      replaceContent,
    })

    expect(result).toBeNull()
  })

  it('should handle searchContent with leading empty lines and extra indentation', () => {
    const oldFileContent = '\n    const a = 1;\n    const b = 2;\n'
    const searchContent = '\nconst a = 1;\nconst b = 2;\n'
    const replaceContent = '\nconst a = 10;\nconst b = 20;\n'

    const result = tryToDoStringReplacementWithExtraIndentation({
      oldFileContent,
      searchContent,
      replaceContent,
    })

    expect(result).not.toBeNull()
    expect(result!.searchContent).toBe('\n    const a = 1;\n    const b = 2;\n')
    expect(result!.replaceContent).toBe(
      '\n    const a = 10;\n    const b = 20;\n',
    )
  })
})
