import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { DEFAULT_HEADERS } from './index.mjs';


export async function handlePutRequest(event, DOC_CLIENT, TABLE_NAME) {
    const timestamp = new Date().toISOString();
    const body = JSON.parse(event.body);
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