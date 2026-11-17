import { DEFAULT_HEADERS } from './index.mjs';


export async function handleOptionsRequest(event, DOC_CLIENT, TABLE_NAME) {
    return {
      statusCode: 204,
      headers: { ...DEFAULT_HEADERS },
    };
  };
  