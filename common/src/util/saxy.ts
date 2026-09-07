/**
 * This is a modified version of the Saxy library that emits text nodes immediately
 */
import { Transform } from 'node:stream'
import { StringDecoder } from 'string_decoder'

import { includesMatch, isWhitespace } from './string'

export type TextNode = {
  /** The text value */
  contents: string
}

export type CDATANode = {
  /** The CDATA contents */
  contents: string
}

export type CommentNode = {
  /** The comment contents */
  contents: string
}

export type ProcessingInstructionNode = {
  /** The instruction contents */
  contents: string
}

/** Information about an opened tag */
export type TagOpenNode = {
  /** Name of the tag that was opened. */
  name: string
  /**
   * Attributes passed to the tag, in a string representation
   * (use Saxy.parseAttributes to get an attribute-value mapping).
   */
  attrs: string
  /**
   * Whether the tag self-closes (tags of the form ``).
   * Such tags will not be followed by a closing tag.
   */
  isSelfClosing: boolean

  /**
   * The original text of the tag, including angle brackets and attributes.
   */
  rawTag: string
}

/** Information about a closed tag */
export type TagCloseNode = {
  /** Name of the tag that was closed. */
  name: string

  /**
   * The original text of the tag, including angle brackets.
   */
  rawTag: string
}

export type NextFunction = (err?: Error) => void

export interface SaxyEvents {
  finish: () => void
  error: (err: Error) => void
  text: (data: TextNode) => void
  cdata: (data: CDATANode) => void
  comment: (data: CommentNode) => void
  processinginstruction: (data: ProcessingInstructionNode) => void
  tagopen: (data: TagOpenNode) => void
  tagclose: (data: TagCloseNode) => void
}

export type SaxyEventNames = keyof SaxyEvents

export type SaxyEventArgs =
  | Error
  | TextNode
  | CDATANode
  | CommentNode
  | ProcessingInstructionNode
  | TagOpenNode
  | TagCloseNode

export interface Saxy {
  on<U extends SaxyEventNames>(event: U, listener: SaxyEvents[U]): this
  on(event: string | symbol | Event, listener: (...args: any[]) => void): this
  once<U extends SaxyEventNames>(event: U, listener: SaxyEvents[U]): this
}

/**
 * Schema for defining allowed tags and their children
 */
export type TagSchema = {
  [topLevelTag: string]: (string | RegExp)[] // Allowed child tags
}

/**
 * Nodes that can be found inside an XML stream.
 */
const Node = {
  text: 'text',
  cdata: 'cdata',
  comment: 'comment',
  processingInstruction: 'processinginstruction',
  tagOpen: 'tagopen',
  tagClose: 'tagclose',
  // markupDeclaration: 'markupDeclaration',
} as Record<string, SaxyEventNames>

/**
 * Expand a piece of XML text by replacing all XML entities by
 * their canonical value. Ignore invalid and unknown entities.
 *
 * @param input A string of XML text
 * @return The input string, expanded
 */
const parseEntities = (input: string): string => {
  let position = 0
  let next = 0
  const parts = []

  while ((next = input.indexOf('&', position)) !== -1) {
    if (next > position) {
      const beforeEntity = input.slice(position, next)
      parts.push(beforeEntity)
    }

    const semiColonPos = input.indexOf(';', next)

    if (semiColonPos === -1) {
      const remaining = input.slice(next)
      parts.push(remaining)
      position = input.length
      break
    }

    const entityName = input.slice(next + 1, semiColonPos)

    // If entityName contains invalid characters (space, &, <, >) or is empty,
    // treat the initial & as a literal character
    if (/[ &<>]/.test(entityName) || entityName.length === 0) {
      parts.push('&')
      position = next + 1
      continue
    }

    if (entityName === 'quot') {
      parts.push('"')
    } else if (entityName === 'amp') {
      parts.push('&')
    } else if (entityName === 'apos') {
      parts.push("'")
    } else if (entityName === 'lt') {
      parts.push('<')
    } else if (entityName === 'gt') {
      parts.push('>')
    } else if (entityName.startsWith('#')) {
      let value
      if (entityName[1] === 'x' || entityName[1] === 'X') {
        value = parseInt(entityName.slice(2), 16)
      } else {
        value = parseInt(entityName.slice(1), 10)
      }

      if (Number.isNaN(value)) {
        parts.push('&' + entityName + ';')
      } else {
        parts.push(String.fromCharCode(value))
      }
    } else {
      // Unrecognized named entity, pass through
      parts.push('&' + entityName + ';')
    }
    position = semiColonPos + 1
  }

  if (position < input.length) {
    const remaining = input.slice(position)
    parts.push(remaining)
  }

  const result = parts.join('')
  return result
}

/**
 * Parse a string of XML attributes to a map of attribute names to their values.
 *
 * @param input A string of XML attributes
 * @throws If the string is malformed
 * @return A map of attribute names to their values
 */
export const parseAttrs = (
  input: string,
): { attrs: Record<string, string>; errors: string[] } => {
  const attrs = {} as Record<string, string>
  const end = input.length
  let position = 0
  const errors: string[] = []

  const seekNextWhitespace = (pos: number): number => {
    pos += 1
    while (pos < end && !isWhitespace(input[pos])) {
      pos += 1
    }
    return pos
  }

  attrLoop: while (position < end) {
    // Skip all whitespace
    if (isWhitespace(input[position])) {
      position += 1
      continue
    }

    // Check that the attribute name contains valid chars
    let startName = position

    while (input[position] !== '=' && position < end) {
      if (isWhitespace(input[position])) {
        errors.push(
          `Attribute names may not contain whitespace: ${input.slice(startName, position)}`,
        )
        continue attrLoop
      }

      position += 1
    }

    // This is XML, so we need a value for the attribute
    if (position === end) {
      errors.push(
        `Expected a value for the attribute: ${input.slice(startName, position)}`,
      )
      break
    }

    const attrName = input.slice(startName, position)
    position += 1
    const startQuote = input[position]
    position += 1

    if (startQuote !== '"' && startQuote !== "'") {
      position = seekNextWhitespace(position)
      errors.push(
        `Attribute values should be quoted: ${input.slice(startName, position)}`,
      )
      continue
    }

    const endQuote = input.indexOf(startQuote, position)

    if (endQuote === -1) {
      position = seekNextWhitespace(position)
      errors.push(
        `Unclosed attribute value: ${input.slice(startName, position)}`,
      )
      continue
    }

    const attrValue = input.slice(position, endQuote)

    attrs[attrName] = attrValue
    position = endQuote + 1
  }

  return { attrs, errors }
}

/**
 * Find the first character in a string that matches a predicate
 * while being outside the given delimiters.
 *
 * @param haystack String to search in
 * @param predicate Checks whether a character is permissible
 * @param [delim=''] Delimiter inside which no match should be
 * returned. If empty, all characters are considered.
 * @param [fromIndex=0] Start the search from this index
 * @return Index of the first match, or -1 if no match
 */
const findIndexOutside = (
  haystack: string,
  predicate: Function,
  delim = '',
  fromIndex = 0,
) => {
  const length = haystack.length
  let index = fromIndex
  let inDelim = false

  while (index < length && (inDelim || !predicate(haystack[index]))) {
    if (haystack[index] === delim) {
      inDelim = !inDelim
    }

    ++index
  }

  return index === length ? -1 : index
}

/**
 * Parse an XML stream and emit events corresponding
 * to the different tokens encountered.
 */
export class Saxy extends Transform {
  private _decoder: StringDecoder
  private _tagStack: string[]
  private _waiting: { token: string; data: unknown } | null
  private _schema: TagSchema | null
  private _textBuffer: string // NEW: Text buffer as class member
  private _shouldParseEntities: boolean

  /**
   * Parse a string of XML attributes to a map of attribute names
   * to their values
   *
   * @param input A string of XML attributes
   * @throws If the string is malformed
   * @return A map of attribute names to their values
   */
  static parseAttrs = parseAttrs

  /**
   * Expand a piece of XML text by replacing all XML entities
   * by their canonical value. Ignore invalid and unknown
   * entities
   *
   * @param input A string of XML text
   * @return The input string, expanded
   */
  static parseEntities = parseEntities

  /**
   * Create a new parser instance.
   * @param schema Optional schema defining allowed top-level tags and their children
   */
  constructor(schema?: TagSchema, shouldParseEntities: boolean = true) {
    super({ decodeStrings: false, defaultEncoding: 'utf8' })

    this._decoder = new StringDecoder('utf8')

    // Stack of tags that were opened up until the current cursor position
    this._tagStack = []

    // Not waiting initially
    this._waiting = null

    // Store schema if provided
    this._schema = schema || null

    // Initialize text buffer
    this._textBuffer = ''

    this._shouldParseEntities = shouldParseEntities
  }

  /**
   * Handle a chunk of data written into the stream.
   *
   * @param chunk Chunk of data.
   * @param encoding Encoding of the string, or 'buffer'.
   * @param callback Called when the chunk has been parsed, with
   * an optional error argument.
   */
  public _write(
    chunk: Buffer | string,
    encoding: string,
    callback: NextFunction,
  ) {
    const data =
      encoding === 'buffer'
        ? this._decoder.write(chunk as Buffer)
        : (chunk as string)

    this._parseChunk(data, callback)
  }

  /**
   * Handle the end of incoming data.
   *
   * @param callback
   */
  public _final(callback: NextFunction) {
    // Make sure all data has been extracted from the decoder
    this._parseChunk(this._decoder.end(), (err?: Error) => {
      if (err) {
        callback(err)
        return
      }

      // Handle any remaining text buffer
      if (this._textBuffer.length > 0) {
        const parsedText = this._shouldParseEntities
          ? parseEntities(this._textBuffer)
          : this._textBuffer
        this.emit(Node.text, { contents: parsedText })
        this._textBuffer = ''
      }

      // Handle unclosed nodes
      if (this._waiting !== null) {
        switch (this._waiting.token) {
          case Node.text:
            // Text nodes are implicitly closed
            this.emit('text', { contents: this._waiting.data })
            break
          case Node.cdata:
            callback(new Error('Unclosed CDATA section'))
            return
          case Node.comment:
            callback(new Error('Unclosed comment'))
            return
          case Node.processingInstruction:
            callback(new Error('Unclosed processing instruction'))
            return
          case Node.tagOpen:
          case Node.tagClose:
            // We do not distinguish between unclosed opening
            // or unclosed closing tags
            // callback(new Error('Unclosed tag'))
            return
          default:
          // Pass
        }
      }

      if (this._tagStack.length !== 0) {
        // callback(new Error(`Unclosed tags: ${this._tagStack.join(',')}`))
        return
      }

      callback()
    })
  }

  /**
   * Immediately parse a complete chunk of XML and close the stream.
   *
   * @param input Input chunk.
   */
  public parse(input: Buffer | string): this {
    this.end(input)
    return this
  }

  /**
   * Put the stream into waiting mode, which means we need more data
   * to finish parsing the current token.
   *
   * @param token Type of token that is being parsed.
   * @param data Pending data.
   */
  private _wait(token: string, data: unknown) {
    this._waiting = { token, data }
  }

  /**
   * Put the stream out of waiting mode.
   *
   * @return Any data that was pending.
   */
  private _unwait() {
    if (this._waiting === null) {
      return ''
    }

    const data = this._waiting.data
    this._waiting = null
    return data
  }

  /**
   * Handle the opening of a tag in the text stream.
   *
   * Push the tag into the opened tag stack and emit the
   * corresponding event on the event emitter.
   *
   * @param node Information about the opened tag.
   */
  private _handleTagOpening(node: TagOpenNode) {
    const { name } = node

    // If we have a schema, validate against it
    if (this._schema) {
      // For top-level tags
      if (this._tagStack.length === 0) {
        // Convert to text if not in schema
        if (!this._schema[name]) {
          this.emit(Node.text, { contents: node.rawTag })
          return
        }
      }
      // For nested tags
      else {
        const parentTag = this._tagStack[this._tagStack.length - 1]
        // Convert to text if parent not in schema or this tag not allowed as child
        if (
          !this._schema[parentTag] ||
          !includesMatch(this._schema[parentTag], name)
        ) {
          this.emit(Node.text, { contents: node.rawTag })
          return
        }
      }
    }

    if (!node.isSelfClosing) {
      this._tagStack.push(node.name)
    }

    this.emit(Node.tagOpen, node)

    if (node.isSelfClosing) {
      this.emit(Node.tagClose, {
        name: node.name,
        rawTag: '',
      })
    }
  }

  /**
   * Parse a XML chunk.
   *
   * @private
   * @param input A string with the chunk data.
   * @param callback Called when the chunk has been parsed, with
   * an optional error argument.
   */
  private _parseChunk(input: string, callback: NextFunction) {
    // Use pending data if applicable and get out of waiting mode
    const waitingData = this._unwait()
    input = waitingData + input

    let chunkPos = 0
    const end = input.length

    while (chunkPos < end) {
      if (
        input[chunkPos] !== '<' ||
        (chunkPos + 1 < end && !this._isXMLTagStart(input, chunkPos + 1))
      ) {
        // Find next potential tag, but verify it's actually a tag
        let nextTag = input.indexOf('<', chunkPos)
        while (
          nextTag !== -1 &&
          nextTag + 1 < end &&
          !this._isXMLTagStart(input, nextTag + 1)
        ) {
          nextTag = input.indexOf('<', nextTag + 1)
        }

        // We read a TEXT node but there might be some
        // more text data left, so we wait
        if (nextTag === -1) {
          let chunk = input.slice(chunkPos)

          if (this._tagStack.length === 1 && !chunk.trim()) {
            chunk = ''
          }

          // Check for incomplete entity at end
          const lastAmp = chunk.lastIndexOf('&')
          if (
            this._shouldParseEntities &&
            lastAmp !== -1 &&
            chunk.indexOf(';', lastAmp) === -1
          ) {
            // Only consider it a pending entity if it looks like the start of one
            const postAmp = chunk.slice(lastAmp + 1)
            const isPotentialEntity =
              /^(#\d*)?$/.test(postAmp) || // Numeric entity
              /^[a-zA-Z]{0,6}$/.test(postAmp) // Named entity
            if (isPotentialEntity) {
              // Store incomplete entity for next chunk
              this._wait(Node.text, chunk.slice(lastAmp))
              chunk = chunk.slice(0, lastAmp)
            }
          }

          if (chunk.length > 0) {
            this._textBuffer += chunk
          }

          chunkPos = end
          break
        }

        // A tag follows, so we can be confident that
        // we have all the data needed for the TEXT node
        let chunk = input.slice(chunkPos, nextTag)

        if (this._tagStack.length === 1 && !chunk.trim()) {
          chunk = ''
        }

        // Only emit non-whitespace text or text within a single tag (not between tags)
        if (chunk.length > 0) {
          this._textBuffer += chunk
        }

        // We've reached a tag boundary, emit any buffered text
        if (this._textBuffer.length > 0) {
          const parsedText = this._shouldParseEntities
            ? parseEntities(this._textBuffer)
            : this._textBuffer
          this.emit(Node.text, { contents: parsedText })
          this._textBuffer = ''
        }

        chunkPos = nextTag
      }

      // Invariant: the cursor now points on the name of a tag,
      // after an opening angled bracket
      chunkPos += 1

      // Recognize regular tags (< ... >)
      const tagClose = findIndexOutside(
        input,
        (char: string) => char === '>',
        '"',
        chunkPos,
      )

      if (tagClose === -1) {
        this._wait(Node.tagOpen, input.slice(chunkPos - 1))
        break
      }

      // Check if the tag is a closing tag
      if (input[chunkPos] === '/') {
        const tagName = input.slice(chunkPos + 1, tagClose)
        const stackedTagName = this._tagStack[this._tagStack.length - 1]

        // Convert closing tag to text if it doesn't match schema validation
        if (this._schema) {
          // For top-level tags
          if (this._tagStack.length === 1) {
            if (!this._schema[tagName]) {
              const rawTag = input.slice(chunkPos - 1, tagClose + 1)
              this.emit(Node.text, { contents: rawTag })
              chunkPos = tagClose + 1
              continue
            }
          }
          // For nested tags
          else {
            const parentTag = this._tagStack[this._tagStack.length - 2]
            if (
              !this._schema[parentTag] ||
              !includesMatch(this._schema[parentTag], tagName)
            ) {
              const rawTag = input.slice(chunkPos - 1, tagClose + 1)
              this.emit(Node.text, { contents: rawTag })
              chunkPos = tagClose + 1
              continue
            }
          }
        }

        if (tagName === stackedTagName) {
          this._tagStack.pop()
        }

        // Only emit if the tag matches what we expect (or if there is no schema)
        if (!this._schema || stackedTagName === tagName) {
          this.emit(Node.tagClose, {
            name: tagName,
            rawTag: input.slice(chunkPos - 1, tagClose + 1),
          })
        } else {
          // Emit as text if the tag doesn't match
          const rawTag = input.slice(chunkPos - 1, tagClose + 1)
          this.emit(Node.text, { contents: rawTag })
        }

        chunkPos = tagClose + 1
        continue
      }

      // Check if the tag is self-closing
      const isSelfClosing = input[tagClose - 1] === '/'
      let realTagClose = isSelfClosing ? tagClose - 1 : tagClose

      // Extract the tag name and attributes
      const whitespace = input.slice(chunkPos).search(/\s/)

      // Get the raw tag text for potential text node conversion
      const rawTag = input.slice(chunkPos - 1, tagClose + 1)

      if (whitespace === -1 || whitespace >= tagClose - chunkPos) {
        // Tag without any attribute
        this._handleTagOpening({
          name: input.slice(chunkPos, realTagClose),
          attrs: '',
          isSelfClosing,
          rawTag,
        })
      } else if (whitespace === 0) {
        // Invalid tag starting with whitespace - emit as text
        this.emit(Node.text, { contents: rawTag })
      } else {
        // Tag with attributes
        this._handleTagOpening({
          name: input.slice(chunkPos, chunkPos + whitespace),
          attrs: input.slice(chunkPos + whitespace, realTagClose),
          isSelfClosing,
          rawTag,
        })
      }

      chunkPos = tagClose + 1
    }

    // Emit any buffered text at the end of the chunk if there's no pending entity
    if (this._textBuffer.length > 0) {
      const parsedText = this._shouldParseEntities
        ? parseEntities(this._textBuffer)
        : this._textBuffer
      this.emit(Node.text, { contents: parsedText })
      this._textBuffer = ''
    }

    callback()
  }

  /**
   * Check if a potential XML tag start is actually a valid tag
   * @param input The input string
   * @param pos Position after the < character
   * @returns true if this is a valid XML tag start
   */
  private _isXMLTagStart(input: string, pos: number): boolean {
    // Valid XML tags must start with a letter, underscore or colon
    // https://www.w3.org/TR/xml/#NT-NameStartChar
    const firstChar = input[pos]
    return /[A-Za-z_:]/.test(firstChar) || firstChar === '/'
  }
}
