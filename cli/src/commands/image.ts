import { parseImageCommandArgs } from './parse-image-args'
import { getProjectRoot } from '../project-files'
import { validateAndAddImage } from '../utils/pending-attachments'

export { parseImageCommandArgs }

/**
 * Handle the /image command to attach an image file.
 * Usage: /image <path> [message]
 * Example: /image ./screenshot.png please analyze this
 * 
 * Returns the optional message as transformedPrompt (empty string if none).
 * Errors are shown in the pending images banner with auto-remove.
 */
export async function handleImageCommand(args: string): Promise<string> {
  const { imagePath, message } = parseImageCommandArgs(args)

  if (imagePath) {
    await validateAndAddImage(imagePath, getProjectRoot())
  }

  return message
}
