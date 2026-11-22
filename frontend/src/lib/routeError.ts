/** Error with an HTTP status, thrown by API route helpers and mapped to a JSON response. */
export class RouteError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
