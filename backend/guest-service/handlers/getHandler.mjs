import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { DEFAULT_HEADERS } from './index.mjs';


export async function handleGetRequest(event, DOC_CLIENT, TABLE_NAME) {
    const query = event.queryStringParameters;
    const eventId = query.eventId;    // required
    const guestId = query.guestId;    // optional
  
    try {
      const guests = [];
      let lastKey;
  
      let keyCondition = "eventId = :eventId";
      const values = { ":eventId": eventId };
  
      if (guestId) {
        keyCondition += " AND guestId = :guestId";
        values[":guestId"] = guestId;
      }
  
      // Query returns at most 1 MB per call, so keep fetching until there are no more pages
      do {
        const result = await DOC_CLIENT.send(new QueryCommand({
          TableName: TABLE_NAME,
          KeyConditionExpression: keyCondition,
          ExpressionAttributeValues: values,
          ExclusiveStartKey: lastKey,
        }));
  
        guests.push(...(result.Items ?? []));
        lastKey = result.LastEvaluatedKey;
      } while (lastKey);
  
      return {
        statusCode: 200,
        headers: { ...DEFAULT_HEADERS },
        body: JSON.stringify({ 
          count: guests.length, 
          guests: guests 
        }),
      };
    } catch (err) {
      throw err;
    }
  };