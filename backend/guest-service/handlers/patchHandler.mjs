import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { DEFAULT_HEADERS } from './index.mjs';


export async function handlePatchRequest(event, DOC_CLIENT, TABLE_NAME) {
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
  
    // 2. Validate the ids (pulling them out also keeps them out of the update)
    const { eventId, guestId, ...fields } = body.guest ?? {};
    if (!eventId || !guestId) {
      return {
        statusCode: 400,
        headers: { ...DEFAULT_HEADERS },
        body: JSON.stringify({ error: "guest.eventId and guest.guestId are required" }),
      };
    }
  
    // 3. Every field except the keys is patchable
    //    updatedAt is skipped because the server always sets it
    const updates = Object.entries(fields).filter(
      ([name, value]) => name !== "updatedAt" && value !== undefined
    );
  
    if (updates.length === 0) {
      return {
        statusCode: 400,
        headers: { ...DEFAULT_HEADERS },
        body: JSON.stringify({ error: "No fields to update were provided" }),
      };
    }
  
    // 4. Build the UpdateExpression dynamically using indexed placeholders, e.g.
    //    SET #f0 = :v0, #f1 = :v1, #updatedAt = :updatedAt
    const expressionNames = {};
    const expressionValues = {};
    const setClauses = [];
  
    updates.forEach(([name, value], i) => {
      expressionNames[`#f${i}`] = name;
      expressionValues[`:v${i}`] = value;
      setClauses.push(`#f${i} = :v${i}`);
    });
  
    expressionNames["#updatedAt"] = "updatedAt";
    expressionValues[":updatedAt"] = new Date().toISOString();
    setClauses.push("#updatedAt = :updatedAt");
  
    expressionNames["#guestId"] = "guestId"; // used by the condition below
  
    // 5. Run the update
    try {
      const result = await DOC_CLIENT.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { eventId, guestId },
        UpdateExpression: `SET ${setClauses.join(", ")}`,
        ConditionExpression: "attribute_exists(#guestId)", // don't create missing guests
        ExpressionAttributeNames: expressionNames,
        ExpressionAttributeValues: expressionValues,
        ReturnValues: "ALL_NEW",                           // return the updated item
      }));
  
      console.log("UpdateCommand succeeded:", eventId, guestId);
      return {
        statusCode: 200,
        headers: { ...DEFAULT_HEADERS },
        body: JSON.stringify({ message: "Updated", guest: result.Attributes }),
      };
    } catch (err) {
      if (err.name === "ConditionalCheckFailedException") {
        return {
          statusCode: 404,
          headers: { ...DEFAULT_HEADERS },
          body: JSON.stringify({ error: `Guest ${guestId} not found for event ${eventId}` }),
        };
      }
      console.error("UpdateCommand failed:", err.name, err.message);
      throw err; // handled by the 500 in handler
    }
  }