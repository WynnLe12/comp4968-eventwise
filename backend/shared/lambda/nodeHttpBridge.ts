import { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import type { Socket } from "node:net";

export interface BridgeResponse {
    statusCode: number;
    headers: Record<string, string>;
    body: string;
}

export async function invokeNodeHttpHandler(
    method: string,
    path: string,
    body: Buffer,
    handle: (
        request: IncomingMessage,
        response: ServerResponse
    ) => Promise<void>,
    headers: Record<string, string> = {}
): Promise<BridgeResponse> {
    const socket = new PassThrough() as unknown as Socket;
    const request = new IncomingMessage(socket);

    request.method = method;
    request.url = path;
    request.headers = {
        ...Object.fromEntries(
            Object.entries(headers).map(([key, value]) => [
                key.toLowerCase(),
                value,
            ])
        ),
        "content-length": String(body.length),
    };

    const response = new ServerResponse(request);

    // Prevent ServerResponse from writing to a real network socket.
    const chunks: Buffer[] = [];

    response.assignSocket(socket);

    const originalWrite = response.write.bind(response);
    const originalEnd = response.end.bind(response);

    response.write = ((chunk: unknown) => {
        if (chunk !== undefined) {
            chunks.push(
                Buffer.isBuffer(chunk)
                    ? chunk
                    : Buffer.from(String(chunk))
            );
        }
        return true;
    }) as typeof response.write;

    response.end = ((chunk?: unknown) => {
        if (chunk !== undefined) {
            chunks.push(
                Buffer.isBuffer(chunk)
                    ? chunk
                    : Buffer.from(String(chunk))
            );
        }
        originalEnd();
        return response;
    }) as typeof response.end;

    // Supply the request body expected by the existing handlers.
    request.push(body);
    request.push(null);

    try {
        await handle(request, response);

        return {
            statusCode: response.statusCode,
            headers: {
                "Content-Type":
                    String(response.getHeader("content-type") ??
                        "application/json; charset=utf-8"),
            },
            body: Buffer.concat(chunks).toString("utf8"),
        };
    } finally {
        response.write = originalWrite;
        response.end = originalEnd;
    }
}
