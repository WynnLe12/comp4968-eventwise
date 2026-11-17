import { BatchWriteCommand, DeleteCommand, QueryCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DEFAULT_HEADERS } from './index.mjs';


// eventId and guestId are both required
// delete all entries related to the eventId if the guestId is a string "*"
export async function handleDeleteRequest(event, DOC_CLIENT, TABLE_NAME) {
    // 1. Parse the request body
    let body;
    try {
      const raw = event.isBase64Encoded
        ? Buffer.from(event.body ?? "", "base64").toString("utf-8")
        : event.body;
      body = JSON.parse(raw ?? "{}");
    } catch {
      return {
        statusCode: 400,
        headers: { ...DEFAULT_HEADERS },
        body: JSON.stringify({ error: "Request body must be valid JSON" }),
      };
    }
  
    // 2. Validate the ids
    const { eventId, guestId } = body.guest ?? {};
    if (!eventId || !guestId) {
      return {
        statusCode: 400,
        headers: { ...DEFAULT_HEADERS },
        body: JSON.stringify({ error: "guest.eventId and guest.guestId are required" }),
      };
    }
  
    // 3a. Wildcard: delete every guest for the event
    if (guestId === "*") {
      const deletedCount = await deleteAllGuests(eventId);
      console.log(`Deleted ${deletedCount} guests for eventId ${eventId}`);
      return {
        statusCode: 200,
        headers: { ...DEFAULT_HEADERS },
        body: JSON.stringify({ message: "Deleted", eventId, deletedCount }),
      };
    }
  
    // 3b. Single guest
    try {
      const result = await DOC_CLIENT.send(new DeleteCommand({
        TableName: TABLE_NAME,
        Key: { eventId, guestId },
        ConditionExpression: "attribute_exists(guestId)",
        ReturnValues: "ALL_OLD",
      }));
  
      console.log("DeleteCommand succeeded:", eventId, guestId);
      return {
        statusCode: 200,
        headers: { ...DEFAULT_HEADERS },
        body: JSON.stringify({ message: "Deleted", guest: result.Attributes }),
      };
    } catch (err) {
      if (err.name === "ConditionalCheckFailedException") {
        return {
          statusCode: 404,
          headers: { ...DEFAULT_HEADERS },
          body: JSON.stringify({ error: `Guest ${guestId} not found for event ${eventId}` }),
        };
      }
      console.error("DeleteCommand failed:", err.name, err.message);
      throw err;
    }
  
    async function deleteAllGuests(eventId) {
      // 1. Collect all keys for the event (only the key attributes, to keep it cheap)
      const keys = [];
      let lastKey;
      do {
        const result = await DOC_CLIENT.send(new QueryCommand({
          TableName: TABLE_NAME,
          KeyConditionExpression: "eventId = :eventId",
          ExpressionAttributeValues: { ":eventId": eventId },
          ProjectionExpression: "eventId, guestId",
          ExclusiveStartKey: lastKey,
        }));
        keys.push(...(result.Items ?? []));
        lastKey = result.LastEvaluatedKey;
      } while (lastKey);
    
      // 2. Delete in batches of 25 (the BatchWrite limit)
      for (let i = 0; i < keys.length; i += 25) {
        let requests = keys.slice(i, i + 25).map((key) => ({
          DeleteRequest: { Key: { eventId: key.eventId, guestId: key.guestId } },
        }));
    
        // Retry any items DynamoDB couldn't process (e.g. throttling), with backoff
        for (let attempt = 0; requests.length > 0; attempt++) {
          if (attempt >= 5) {
            throw new Error(`Failed to delete ${requests.length} items after retries`);
          }
          if (attempt > 0) {
            await new Promise((r) => setTimeout(r, 100 * 2 ** attempt));
          }
    
          const result = await DOC_CLIENT.send(new BatchWriteCommand({
            RequestItems: { [TABLE_NAME]: requests },
          }));
          requests = result.UnprocessedItems?.[TABLE_NAME] ?? [];
        }
      }
      return keys.length;
    }
  }