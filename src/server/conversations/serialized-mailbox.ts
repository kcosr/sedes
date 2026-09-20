export class MailboxClosedError extends Error {
  constructor() {
    super("Conversation actor mailbox is closed.");
    this.name = "MailboxClosedError";
  }
}

/**
 * One failure must not poison later actor work, but close must form a hard
 * boundary: work accepted before close drains; work offered afterward fails.
 */
export class SerializedMailbox {
  private tail: Promise<void> = Promise.resolve();
  private accepting = true;

  enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    if (!this.accepting) {
      return Promise.reject(new MailboxClosedError());
    }

    const result = this.tail.then(operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async close(): Promise<void> {
    this.accepting = false;
    await this.tail;
  }

  get closed(): boolean {
    return !this.accepting;
  }
}
