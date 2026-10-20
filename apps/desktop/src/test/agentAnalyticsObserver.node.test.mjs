// @vitest-environment node
import { expect, test } from 'vitest';
import { metadataFacts } from '@ai4s/sdk/agent-analytics-observer';

test('the native analytics SDK subpath resolves to sanitized metadata in Web service tests', () => {
  const facts = metadataFacts({ type: 'message.part.updated', properties: { part: {
    type: 'tool', callID: 'owned-call', sessionID: 'owned-session', messageID: 'owned-message',
    tool: 'bash', state: { status: 'completed', time: { start: 100, end: 120 },
      input: { command: 'PRIVATE_COMMAND' }, output: 'PRIVATE_OUTPUT' },
  } } });
  expect(facts).toEqual([{ kind: 'tool', entityId: 'owned-message:owned-call',
    messageId: 'owned-message', sessionId: 'owned-session', capabilityId: 'bash',
    outcome: 'completed', startedAt: 100, endedAt: 120 }]);
});
