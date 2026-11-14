import { createCognitoAuthenticator } from "./cognito";

// Keep the event handler API; verify lazily so health checks and isolated tests
// don't require Cognito configuration until an authenticated request is made.
const authenticate = createCognitoAuthenticator();

export function verifyToken(token: string): Promise<string> {
  return authenticate("Bearer " + token);
}
