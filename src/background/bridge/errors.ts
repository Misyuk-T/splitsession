/** An error whose message is meant for the agent (a mistake in the call, a page that cannot be operated, a tool switched off). */
export class ToolError extends Error {
  /** `pageContent`: the message holds something the page said (a thrown value, a dialog's text). The agent gets it; the log never does. */
  constructor(
    message: string,
    readonly pageContent = false,
  ) {
    super(message);
  }
}
