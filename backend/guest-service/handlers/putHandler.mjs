import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { DEFAULT_HEADERS } from './index.mjs';


export async function handlePutRequest(event, DOC_CLIENT, TABLE_NAME) {
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

    const timestamp = new Date().toISOString();
    const tableEntry = {
      ...body.guest,
      rsvpStatus: "UNINVITED",  // should be enum: UNINVITED, PENDING, ACCEPTED, REJECTED
      createdAt: timestamp,
      updatedAt: timestamp
    }
  
    try {
      const result = await DOC_CLIENT.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: tableEntry,
        ConditionExpression: "attribute_not_exists(guestId)"
      }));
  
      console.log("PutCommand succeeded:", result.$metadata.httpStatusCode);
      return { 
        statusCode: 201, 
        headers: { ...DEFAULT_HEADERS }, 
        body: JSON.stringify({ message: "Created" }) 
      };
    } catch (err) {
      console.error("PutCommand failed:", err.name, err.message);
      throw err;
    }
  }