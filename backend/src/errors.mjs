export class ResearchError extends Error {
  constructor(code, message, status = 500) { super(message); this.name = 'ResearchError'; this.code = code; this.status = status; }
}
