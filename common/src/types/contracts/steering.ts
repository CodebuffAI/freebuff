import type { ImagePart, TextPart } from '../messages/content-part'

/** A fresh user message delivered at a running agent's next step boundary. */
export type SteeringMessage =
  | string
  | { prompt: string; content?: Array<TextPart | ImagePart> }

/** Async hosts may load attachment bytes before handing the batch to the agent. */
export type DrainSteeringMessages = () =>
  | SteeringMessage[]
  | Promise<SteeringMessage[]>
