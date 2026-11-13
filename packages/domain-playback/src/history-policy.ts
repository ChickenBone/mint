export class ListeningHistoryInputError extends Error {
  constructor() {
    super("Listening episode cannot start in the future.");
    this.name = "ListeningHistoryInputError";
  }
}

export function acceptsListeningEvent(input: {
  privateSession: boolean;
  listenedMs: number;
  startedAt?: string;
  historyAfter: Date | null;
  now: Date;
}): boolean {
  if (input.privateSession || input.listenedMs < 1000) return false;
  const startedAt = input.startedAt ? new Date(input.startedAt) : undefined;
  if (startedAt && startedAt.getTime() > input.now.getTime()) {
    throw new ListeningHistoryInputError();
  }
  if (input.historyAfter && (!startedAt || startedAt < input.historyAfter)) return false;
  return true;
}
