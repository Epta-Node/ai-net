import { z } from "zod";
import { registerAgent } from "../../registry/registry";
import { Agent, AgentResult, SubTask } from "../../types/agent";
import { VeniceClient } from "../../venice/venice";

export const HEX_COLOR_REGEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const HexColorSchema = z
  .string()
  .regex(HEX_COLOR_REGEX, "hex must be #RGB or #RRGGBB");

const UIElementSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  description: z.string().min(1),
});

const WireframeSectionSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  layout: z.enum(["grid", "flex", "absolute"]),
  elements: z.array(UIElementSchema).min(1),
});

const ColorTokenSchema = z.object({
  name: z.string().min(1),
  hex: HexColorSchema,
  usage: z.string().min(1),
});

const ComponentNodeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  parentId: z.string().min(1).nullable().optional(),
  description: z.string().min(1),
});

const AssetEntrySchema = z.object({
  name: z.string().min(1),
  type: z.enum(["icon", "image", "font"]),
  description: z.string().min(1),
  suggestedSource: z.string().min(1),
});

const ComponentHierarchySchema = z
  .array(ComponentNodeSchema)
  .min(1)
  .superRefine((nodes: ComponentNode[], ctx: z.RefinementCtx) => {
    const ids = new Set<string>();

    for (const [index, node] of nodes.entries()) {
      if (ids.has(node.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate component id: ${node.id}`,
          path: [index, "id"],
        });
      }
      ids.add(node.id);
    }

    const rootNodes = nodes.filter((node) => node.parentId == null);
    if (rootNodes.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "componentHierarchy must contain exactly one root node",
        path: [],
      });
    }

    const byId = new Map(nodes.map((node) => [node.id, node]));

    for (const [index, node] of nodes.entries()) {
      if (node.parentId && !byId.has(node.parentId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unknown parentId: ${node.parentId}`,
          path: [index, "parentId"],
        });
      }

      const visited = new Set<string>();
      let current: ComponentNode | undefined = node;

      while (current?.parentId) {
        if (visited.has(current.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Circular component hierarchy at: ${node.id}`,
            path: [index, "parentId"],
          });
          break;
        }

        visited.add(current.id);
        current = byId.get(current.parentId);
      }
    }
  });

export const DesignOutputSchema = z.object({
  wireframes: z.array(WireframeSectionSchema).min(2),
  colorPalette: z.array(ColorTokenSchema).min(4).max(12),
  componentHierarchy: ComponentHierarchySchema,
  assetManifest: z
    .array(AssetEntrySchema)
    .min(1)
    .refine(
      (assets: AssetEntry[]) =>
        assets.some((asset: AssetEntry) => asset.type === "icon"),
      {
        message: "assetManifest must include at least one icon asset",
      },
    ),
});

export type UIElement = z.infer<typeof UIElementSchema>;
export type WireframeSection = z.infer<typeof WireframeSectionSchema>;
export type ColorToken = z.infer<typeof ColorTokenSchema>;
export type ComponentNode = z.infer<typeof ComponentNodeSchema>;
export type AssetEntry = z.infer<typeof AssetEntrySchema>;
export type DesignOutput = z.infer<typeof DesignOutputSchema>;

const AGENT_ID = "design-agent-1";
const AGENT_NAME = "Design Agent";
const AGENT_CAPABILITY = "design";

export class DesignAgent implements Agent {
  constructor(private readonly venice: VeniceClient) {}

  start(): void {
    registerAgent({
      id: AGENT_ID,
      name: AGENT_NAME,
      capability: AGENT_CAPABILITY,
      priceXLM: 1,
      stellarAddress: "",
    });
  }

  async healthCheck(): Promise<boolean> {
    return Boolean(process.env.VENICE_API_KEY);
  }

  async execute(task: SubTask): Promise<AgentResult> {
    const upstreamContext = task.upstreamResults?.length
      ? `\n\nUpstream context:\n${JSON.stringify(task.upstreamResults, null, 2)}`
      : "";

    const prompt = [
      "You are a senior product designer and UI/UX systems thinker. Respond with valid JSON only, no markdown.",
      "Create implementation-ready UI/UX guidance for the product description.",
      "Prefer clear information architecture, strong hierarchy, accessible contrast, and realistic design-system choices.",
      'Format: {"wireframes":[{"name":"string","description":"string","layout":"grid|flex|absolute","elements":[{"name":"string","type":"string","description":"string"}]}],"colorPalette":[{"name":"string","hex":"#RRGGBB","usage":"string"}],"componentHierarchy":[{"id":"string","name":"string","parentId":"string|null","description":"string"}],"assetManifest":[{"name":"string","type":"icon|image|font","description":"string","suggestedSource":"string"}]}',
      "Return at least 2 wireframe sections, 4 to 12 color tokens, exactly one root component node, a valid tree-shaped component hierarchy with no cycles, and at least one icon asset.",
      "Every color hex must be a valid #RGB or #RRGGBB value.",
      upstreamContext,
      `\nProduct description: ${task.prompt}`,
    ].join("\n");

    const model = this.venice.getModelForAgent(AGENT_CAPABILITY);
    const content = await this.venice.complete(prompt, model);
    const parsed = DesignOutputSchema.parse(JSON.parse(content));

    return {
      agentId: AGENT_ID,
      agentName: AGENT_NAME,
      capability: AGENT_CAPABILITY,
      data: parsed,
    };
  }
}

new DesignAgent(new VeniceClient()).start();
