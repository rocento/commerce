export class CommerceError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
