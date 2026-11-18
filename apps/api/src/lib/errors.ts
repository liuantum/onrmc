export class HttpError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}
export const bad = (m: string) => new HttpError(400, m);
export const notFound = (m = 'Not found') => new HttpError(404, m);
