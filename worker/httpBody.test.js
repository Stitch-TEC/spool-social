import { describe, expect, it } from 'vitest';
import { BodyTooLargeError, readBytesBounded, readJsonBounded } from './httpBody.js';

describe('bounded HTTP body reads', () => {
  it('rejects a declared oversize before reading the body', async () => {
    let opened = false;
    const body = { getReader() { opened = true; throw new Error('must not open'); } };

    await expect(readBytesBounded(body, new Headers({ 'Content-Length': '101' }), 100))
      .rejects.toBeInstanceOf(BodyTooLargeError);
    expect(opened).toBe(false);
  });

  it('enforces the streaming ceiling when Content-Length is absent', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(6));
        controller.enqueue(new Uint8Array(6));
        controller.close();
      },
    });
    await expect(readBytesBounded(body, new Headers(), 10))
      .rejects.toMatchObject({ code: 'body_too_large', status: 413 });
  });

  it('parses JSON only after the bounded read succeeds', async () => {
    const request = new Request('https://spool.example/api', {
      method: 'POST',
      body: JSON.stringify({ ok: true }),
    });
    await expect(readJsonBounded(request, 100)).resolves.toEqual({ ok: true });
  });
});
