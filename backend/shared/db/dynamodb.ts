import { DynamoDBClient, type DynamoDBClientConfig } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

// Shared DynamoDB document client.
//
// Configuration (environment variables):
//   AWS_REGION          defaults to us-west-2 (Lambda sets this automatically)
//   DYNAMODB_ENDPOINT   optional; set it to use DynamoDB Local, e.g. http://127.0.0.1:8000
//
// On Lambda, credentials come from the function's execution role. Locally, the AWS SDK
// uses your normal AWS credentials, or any dummy values when DYNAMODB_ENDPOINT points
// at DynamoDB Local.
//
// The client is created lazily and reused, so warm Lambda invocations share it.

let documentClient: DynamoDBDocumentClient | undefined;

export function createDocumentClient(env: NodeJS.ProcessEnv = process.env): DynamoDBDocumentClient {
  const config: DynamoDBClientConfig = { region: env.AWS_REGION ?? "us-west-2" };
  if (env.DYNAMODB_ENDPOINT) config.endpoint = env.DYNAMODB_ENDPOINT;
  return DynamoDBDocumentClient.from(new DynamoDBClient(config), {
    // Optional fields are left out of items instead of being stored as null/undefined.
    marshallOptions: { removeUndefinedValues: true },
  });
}

export function getDocumentClient(): DynamoDBDocumentClient {
  documentClient ??= createDocumentClient();
  return documentClient;
}
