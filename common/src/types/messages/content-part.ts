import z from 'zod/v4'

import { providerMetadataSchema } from './provider-metadata'
import { jsonValueSchema } from '../json'
import { dataContentSchema } from './data-content'

export const textPartSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
  providerOptions: providerMetadataSchema.optional(),
})
export type TextPart = z.infer<typeof textPartSchema>

export const imagePartSchema = z.object({
  type: z.literal('image'),
  image: z.union([dataContentSchema, z.instanceof(URL)]),
  mediaType: z.string().optional(),
  providerOptions: providerMetadataSchema.optional(),
})
export type ImagePart = z.infer<typeof imagePartSchema>

export const filePartSchema = z.object({
  type: z.literal('file'),
  data: z.union([dataContentSchema, z.instanceof(URL)]),
  filename: z.string().optional(),
  mediaType: z.string(),
  providerOptions: providerMetadataSchema.optional(),
})
export type FilePart = z.infer<typeof filePartSchema>

export const reasoningPartSchema = z.object({
  type: z.literal('reasoning'),
  text: z.string(),
  providerOptions: providerMetadataSchema.optional(),
})
export type ReasoningPart = z.infer<typeof reasoningPartSchema>

export const toolCallPartSchema = z.object({
  type: z.literal('tool-call'),
  toolCallId: z.string(),
  toolName: z.string(),
  input: z.record(z.string(), z.unknown()),
  providerOptions: providerMetadataSchema.optional(),
  providerExecuted: z.boolean().optional(),
})
export type ToolCallPart = z.infer<typeof toolCallPartSchema>

export const mediaToolResultOutputSchema = z.object({
  data: z.string(),
  mediaType: z.string(),
})
export type MediaToolResultOutputSchema = z.infer<
  typeof mediaToolResultOutputSchema
>

export const toolResultOutputSchema = z.object({
  value: jsonValueSchema,
  media: mediaToolResultOutputSchema.array().optional(),
})
export type ToolResultOutput = z.infer<typeof toolResultOutputSchema>
