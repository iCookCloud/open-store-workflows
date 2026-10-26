import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import {
  type AssetSource,
  Fill,
  type Filter,
  SHARED_SLOTS,
  type StepResult,
  Verification,
  type WorkflowModule,
  slotJsonSchema,
  z,
} from '@osw/core';
import {
  type RunOptions,
  collectSlots,
  discoverWorkflows,
  executeStep,
  openSource,
} from '@osw/core/node';

export interface ServerOptions {
  assets?: string;
  source?: AssetSource;
  workflows?: readonly WorkflowModule[];
  cwd?: string;
  now?: string;
  actor?: string;
  approvals?: RunOptions['approvals'];
  providers?: RunOptions['providers'];
  allowRecord?: boolean;
}

/** 私密路径相对于 output；复制后再删，不能改变供下游使用的结果。 */
export function stripPrivateOutput(
  result: StepResult<unknown>,
  pointers: readonly string[] = [],
): StepResult<unknown> {
  const safe = structuredClone(result);
  for (const pointer of pointers) {
    if (pointer === '') {
      safe.output = null;
      continue;
    }
    if (!pointer.startsWith('/')) throw new Error('Private output paths must be JSON pointers');
    const segments = pointer
      .slice(1)
      .split('/')
      .map((part) => part.replace(/~1/gu, '/').replace(/~0/gu, '~'));
    let target = safe.output;
    for (const segment of segments.slice(0, -1)) {
      if (typeof target !== 'object' || target === null || !Object.hasOwn(target, segment)) {
        target = undefined;
        break;
      }
      target = (target as Record<string, unknown>)[segment];
    }
    if (typeof target === 'object' && target !== null) {
      const key = segments.at(-1);
      if (key !== undefined) delete (target as Record<string, unknown>)[key];
    }
  }
  return safe;
}

function toolResult(value: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function toolError(error: unknown) {
  return {
    isError: true,
    content: [
      { type: 'text' as const, text: error instanceof Error ? error.message : String(error) },
    ],
  };
}

export async function createOswServer(options: ServerOptions = {}): Promise<Server> {
  const workflows = options.workflows ?? (await discoverWorkflows({ cwd: options.cwd }));
  const assets = options.assets ?? process.env.OSW_ASSETS;
  if (!options.source && !assets)
    throw new Error('MCP requires OSW_ASSETS or an explicit asset source');
  const source = options.source ?? (await openSource(String(assets), workflows));
  const slots = collectSlots(SHARED_SLOTS, workflows);
  const server = new Server({ name: 'osw', version: '0.1.0' }, { capabilities: { tools: {} } });
  const tools = new Map<
    string,
    { description: Tool; invoke: (input: unknown) => Promise<CallToolResult> }
  >();
  // 发布精确 schema，同时让业务缺参由共享 runner 返回 need，而非 SDK 提前截断。
  function registerTool<S extends z.ZodType>(
    name: string,
    config: {
      inputSchema: S;
      description: string;
      annotations?: Tool['annotations'];
      passInvalidInput?: boolean;
    },
    callback: (input: z.infer<S>) => Promise<CallToolResult>,
  ) {
    if (tools.has(name)) throw new Error(`Duplicate MCP tool ${name}`);
    tools.set(name, {
      description: {
        name,
        description: config.description,
        inputSchema: z.toJSONSchema(config.inputSchema, { io: 'input' }) as Tool['inputSchema'],
        ...(config.annotations ? { annotations: config.annotations } : {}),
      },
      async invoke(input) {
        try {
          const parsed = config.passInvalidInput ? input : config.inputSchema.parse(input);
          return await callback(parsed as z.infer<S>);
        } catch (error) {
          return toolError(error);
        }
      },
    });
  }
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...tools.values()].map((tool) => tool.description),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.get(request.params.name);
    if (!tool) return toolError(new Error(`Unknown tool ${request.params.name}`));
    return tool.invoke(request.params.arguments ?? {});
  });
  for (const workflow of workflows) {
    for (const step of workflow.steps) {
      const shortName = step.id.slice(step.id.indexOf('/') + 1);
      registerTool(
        `${workflow.key}_${shortName}`,
        {
          description: `Run ${step.id}; returns output, verification intents, and missing requirements.`,
          inputSchema: step.input,
          passInvalidInput: true,
          annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
        },
        async (input: unknown) => {
          try {
            const execution = await executeStep(step, input, {
              source,
              now: options.now,
              actor: options.actor,
              approvals: options.approvals,
              providers: options.providers,
              record: false,
            });
            return toolResult(
              stripPrivateOutput(execution.result, step.outputPrivate) as unknown as Record<
                string,
                unknown
              >,
            );
          } catch (error) {
            return toolError(error);
          }
        },
      );
    }
  }
  registerTool(
    'osw_slots',
    {
      description: 'List available asset slots and their JSON Schemas.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () =>
      toolResult({
        slots: slots.map((slot) => ({
          name: slot.name,
          slotVersion: slot.slotVersion,
          fieldsets: slot.fieldsets,
          filterable: slot.filterable,
          sortable: slot.sortable,
          schema: slotJsonSchema(slot),
        })),
      }),
  );
  registerTool(
    'osw_query',
    {
      description: 'Read one filtered asset page; limit is at most 50 and no writes are performed.',
      inputSchema: z.object({
        slot: z.string(),
        filter: z.unknown().optional(),
        limit: z.number().int().min(1).max(50).optional(),
        cursor: z.string().nullable().optional(),
        sort: z
          .array(z.object({ field: z.string(), dir: z.enum(['asc', 'desc']) }))
          .max(2)
          .optional(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async (input) => {
      try {
        const slot = slots.find((candidate) => candidate.name === input.slot);
        if (!slot) throw new Error(`Unknown slot ${input.slot}`);
        const page = await source.query(slot, (input.filter ?? null) as Filter | null, {
          limit: input.limit ?? 50,
          cursor: input.cursor,
          sort: input.sort,
        });
        return toolResult({ items: page.items, nextCursor: page.nextCursor });
      } catch (error) {
        return toolError(error);
      }
    },
  );
  if (options.allowRecord) {
    registerTool(
      'osw_record_verifications',
      {
        description: 'Explicitly record verification intents in the configured asset source.',
        inputSchema: z.object({ items: z.array(Verification).max(200) }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async ({ items }) => {
        try {
          return toolResult({ results: await source.recordVerification(items) });
        } catch (error) {
          return toolError(error);
        }
      },
    );
    registerTool(
      'osw_apply_fills',
      {
        description:
          'Explicitly apply verified manual fills; existing values are never overwritten.',
        inputSchema: z.object({ items: z.array(Fill).max(200) }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async ({ items }) => {
        try {
          return toolResult({
            results: source.applyFills
              ? await source.applyFills(items)
              : items.map(() => ({ status: 'unsupported' })),
          });
        } catch (error) {
          return toolError(error);
        }
      },
    );
  }
  return server;
}
