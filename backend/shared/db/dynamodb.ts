import { DynamoDBClient, type DynamoDBClientConfig } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

// Shared DynamoDB document client.
//
// Configuration (environment variables):
//   AWS_REGION          defaults to us-west-2 (Lambda sets this automatically)
//   DYNAMODB_ENDPOINT   optional; set it to use DynamoDB Local, e.g. http://127.0.0.1:8000
//
// Without DYNAMODB_ENDPOINT the client talks to the real AWS table: on Lambda with the
// function's execution role, locally with your own AWS credentials (`aws configure`).
// With DYNAMODB_ENDPOINT it uses fixed dummy credentials, which DynamoDB Local accepts,
// so no AWS keys are needed and real keys are never sent to the local endpoint.
//
// The client is created lazily and reused, so warm Lambda invocations share it.

const LOCAL_CREDENTIALS = { accessKeyId: "local", secretAccessKey: "local" };
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "dynamodb-local"]);

let documentClient: DynamoDBDocumentClient | undefined;

/** True when the endpoint points at DynamoDB Local on this machine (or its compose service). */
export function isLocalEndpoint(endpoint: string | undefined): boolean {
  if (!endpoint) return false;
  try {
    return LOCAL_HOSTS.has(new URL(endpoint).hostname);
  } catch {
    return false;
  }
}

export function createDynamoDBClient(env: NodeJS.ProcessEnv = process.env): DynamoDBClient {
  const config: DynamoDBClientConfig = { region: env.AWS_REGION ?? "us-west-2" };
  if (env.DYNAMODB_ENDPOINT) {
    config.endpoint = env.DYNAMODB_ENDPOINT;
    config.credentials = LOCAL_CREDENTIALS;
  }
  return new DynamoDBClient(config);
}

export function createDocumentClient(env: NodeJS.ProcessEnv = process.env): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(createDynamoDBClient(env), {
    // Optional fields are left out of items instead of being stored as null/undefined.
    marshallOptions: { removeUndefinedValues: true },
  });
}

export function getDocumentClient(): DynamoDBDocumentClient {
  documentClient ??= createDocumentClient();
  return documentClient;
}
