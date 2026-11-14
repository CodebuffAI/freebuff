/**
 * The first message a project created from a starter template sends on its
 * own, so the user lands in a chat where the agent is already bringing the
 * template up rather than an empty composer. Both clients send it after the
 * project opens; a draft the user had typed stays in the composer for their
 * next turn. The templates guidance tells the agent how to show a preview on
 * each runtime, and that a selected template is edited only on request.
 */
export const TEMPLATE_KICKOFF_PROMPT =
  'Start this template and show me a live preview. Don’t change anything yet.'
