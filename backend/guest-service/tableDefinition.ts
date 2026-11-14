import type { CreateTableCommandInput } from "@aws-sdk/client-dynamodb";

// Definition of the guests table, matching the table created in the AWS console
// (see database/dynamodb/guests.md). Used to create the same table in DynamoDB Local.
export function guestsTableDefinition(tableName: string): CreateTableCommandInput {
  return {
    TableName: tableName,
    AttributeDefinitions: [
      { AttributeName: "eventId", AttributeType: "S" },
      { AttributeName: "guestId", AttributeType: "S" },
    ],
    KeySchema: [
      { AttributeName: "eventId", KeyType: "HASH" },
      { AttributeName: "guestId", KeyType: "RANGE" },
    ],
    BillingMode: "PAY_PER_REQUEST",
  };
}
