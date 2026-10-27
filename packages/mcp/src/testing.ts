import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { exampleScratch } from '@osw/core/node';
import { createOswServer } from './index.js';

export { createExampleWorkflowHost as createWorkflowTestHost } from '@osw/core/node';

/** 通用真实 SDK 连接，供各 workflow 包独立验证自己的工具契约。 */
export async function connectTestServer(options: Parameters<typeof createOswServer>[0]) {
  const server = await createOswServer(options);
  const client = new Client({ name: 'osw-test', version: '0.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

export function testDirectory(prefix = 'interfaces'): Promise<string> {
  return exampleScratch(prefix);
}
