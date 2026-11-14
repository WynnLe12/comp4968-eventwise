// Creates the guests table in DynamoDB Local. Safe to run again: an existing table is left as is.
//
//   npm run ddb:up             start DynamoDB Local (docker-compose.dynamodb.yml)
//   npm run ddb:create-table   run this script
//
// Refuses to run unless DYNAMODB_ENDPOINT points at this machine, so it can never
// create or change a table in AWS. The real table is managed in the AWS console.
import "../../shared/config/environment";
import {
  CreateTableCommand,
  DescribeTableCommand,
  ResourceNotFoundException,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";
import { createDynamoDBClient, isLocalEndpoint } from "../../shared/db/dynamodb";
import { DEFAULT_GUESTS_TABLE_NAME } from "../repositories/guestRepository";
import { guestsTableDefinition } from "../tableDefinition";

async function main(): Promise<void> {
  const endpoint = process.env.DYNAMODB_ENDPOINT;
  if (!isLocalEndpoint(endpoint)) {
    console.error(
      "DYNAMODB_ENDPOINT must point at DynamoDB Local, e.g. http://127.0.0.1:8000.\n" +
        "Set it in .env. This script never touches the AWS table.",
    );
    process.exitCode = 1;
    return;
  }

  const tableName = process.env.GUESTS_TABLE_NAME || DEFAULT_GUESTS_TABLE_NAME;
  const client = createDynamoDBClient();
  try {
    try {
      await client.send(new DescribeTableCommand({ TableName: tableName }));
      console.log(`Table ${tableName} already exists at ${endpoint}.`);
      return;
    } catch (error) {
      if (!(error instanceof ResourceNotFoundException)) throw error;
    }
    await client.send(new CreateTableCommand(guestsTableDefinition(tableName)));
    await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: tableName });
    console.log(`Created table ${tableName} at ${endpoint}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Could not create ${tableName} at ${endpoint}: ${message}`);
    console.error("Is DynamoDB Local running? Start it with: npm run ddb:up");
    process.exitCode = 1;
  } finally {
    client.destroy();
  }
}

if (require.main === module) void main();
