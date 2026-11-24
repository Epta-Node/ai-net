/**
 * Task Export routes — Issue #1005
 *
 * GET /api/tasks/:id/export?format=json
 *   Returns the full task object as a downloadable JSON file.
 *   Content-Disposition: attachment; filename="task-<id>.json"
 *   JSON keys are sorted for deterministic output.
 *
 * GET /api/tasks/:id/export?format=pdf
 *   Renders a PDF via pdfkit:
 *     • Cover page  — prompt, submission timestamp, total XLM spent
 *     • One section per DAG node — agent type, output summary, status, XLM paid
 *     • Final page  — payment ledger table
 *     • Footer      — "ai-net • <taskId> • page N of M"
 *
 * Both endpoints:
 *   - Return 404 for unknown task IDs.
 *   - Return 403 when the requesting wallet does not own the task.
 *   - Return 422 when the task is not yet completed.
 */
import { Router, Request, Response } from "express";
import PDFDocument from "pdfkit";
import { createTaskDb, getTaskDb } from "../../db/tasks";
import { createLogger } from "../../utils/logger";

const log = createLogger({ component: "export" });

export const exportRouter = Router({ mergeParams: true });

// ── Helpers ───────────────────────────────────────────────────────────────────

function sortedJson(value: unknown): string {
  return JSON.stringify(value, replacerSortKeys, 2);
}

function replacerSortKeys(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
        a.localeCompare(b),
      ),
    );
  }
  return value;
}

function xlmFromStroops(stroops: bigint | number | string): string {
  const n = typeof stroops === "bigint" ? stroops : BigInt(String(stroops));
  const whole = n / 10_000_000n;
  const frac = n % 10_000_000n;
  return `${whole}.${frac.toString().padStart(7, "0")} XLM`;
}

function walletHeader(req: Request): string {
  return (
    (req.headers["x-wallet-public-key"] as string | undefined) ??
    (req.headers["authorization"]?.replace(/^Bearer\s+/i, "") ?? "")
  );
}

// ── Route ─────────────────────────────────────────────────────────────────────

exportRouter.get("/", (req: Request, res: Response) => {
  const { id } = req.params;
  const format = (req.query.format as string | undefined) ?? "json";

  const taskDb = createTaskDb(getTaskDb());
  const task = taskDb.findById(id);

  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }

  const requestingWallet = walletHeader(req);
  if (task.walletPublicKey && requestingWallet && task.walletPublicKey !== requestingWallet) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  if (task.status !== "completed") {
    res.status(422).json({
      error: "UnprocessableEntity",
      message: `Task is not completed (current status: ${task.status})`,
    });
    return;
  }

  if (format === "json") {
    return handleJsonExport(task, res);
  }

  if (format === "pdf") {
    return handlePdfExport(task, res);
  }

  res.status(400).json({
    error: "InvalidFormat",
    message: 'format must be "json" or "pdf"',
  });
});

// ── JSON export ───────────────────────────────────────────────────────────────

function handleJsonExport(task: unknown, res: Response): void {
  const json = sortedJson(task);
  const taskId = (task as { id: string }).id;
  res.setHeader("Content-Type", "application/json");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="task-${taskId}.json"`,
  );
  res.status(200).send(json);
}

// ── PDF export ────────────────────────────────────────────────────────────────

function handlePdfExport(task: unknown, res: Response): void {
  const t = task as {
    id: string;
    prompt: string;
    createdAt: string;
    dag: Array<{
      nodeId: string;
      type: string;
      status: string;
      result?: unknown;
      amountStroops?: string | number | bigint;
      agentId?: string;
      txHash?: string;
    }>;
  };

  const doc = new PDFDocument({ autoFirstPage: false, bufferPages: true });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="task-${t.id}.pdf"`,
  );

  doc.pipe(res);

  // ── Cover page ────────────────────────────────────────────────────────────
  doc.addPage();
  doc
    .fontSize(22)
    .font("Helvetica-Bold")
    .text("ai-net Task Report", { align: "center" });
  doc.moveDown(1.5);

  doc.fontSize(11).font("Helvetica-Bold").text("Task ID:");
  doc.font("Helvetica").text(t.id);
  doc.moveDown(0.5);

  doc.font("Helvetica-Bold").text("Submitted:");
  doc.font("Helvetica").text(new Date(t.createdAt).toUTCString());
  doc.moveDown(0.5);

  doc.font("Helvetica-Bold").text("Prompt:");
  doc.font("Helvetica").text(t.prompt, { width: 480 });
  doc.moveDown(0.5);

  // Total XLM spent (sum of all node amountStroops)
  let totalStroops = 0n;
  for (const node of t.dag ?? []) {
    if (node.amountStroops != null) {
      try {
        totalStroops += BigInt(String(node.amountStroops));
      } catch {
        /* ignore non-numeric values */
      }
    }
  }
  doc.font("Helvetica-Bold").text("Total XLM Spent:");
  doc.font("Helvetica").text(xlmFromStroops(totalStroops));

  // ── One page per DAG node ─────────────────────────────────────────────────
  for (const node of t.dag ?? []) {
    doc.addPage();
    doc
      .fontSize(14)
      .font("Helvetica-Bold")
      .text(`Node: ${node.nodeId}`, { underline: true });
    doc.moveDown(0.5);

    doc.fontSize(11).font("Helvetica-Bold").text("Agent Type:");
    doc.font("Helvetica").text(node.type ?? "—");

    doc.font("Helvetica-Bold").text("Status:");
    doc.font("Helvetica").text(node.status ?? "—");

    doc.font("Helvetica-Bold").text("XLM Paid:");
    doc
      .font("Helvetica")
      .text(
        node.amountStroops != null
          ? xlmFromStroops(node.amountStroops)
          : "—",
      );

    if (node.result != null) {
      doc.moveDown(0.5);
      doc.font("Helvetica-Bold").text("Output Summary (first 500 chars):");
      const summary = JSON.stringify(node.result).slice(0, 500);
      doc.font("Helvetica").text(summary, { width: 480 });
    }
  }

  // ── Payment ledger page ───────────────────────────────────────────────────
  doc.addPage();
  doc
    .fontSize(14)
    .font("Helvetica-Bold")
    .text("Payment Ledger", { underline: true });
  doc.moveDown(0.5);

  const tableHeaders = ["Node ID", "Agent ID", "Amount XLM", "Tx Hash"];
  const colWidths = [120, 100, 100, 160];
  let xPos = 50;

  doc.fontSize(10).font("Helvetica-Bold");
  for (let i = 0; i < tableHeaders.length; i++) {
    doc.text(tableHeaders[i], xPos, doc.y, { width: colWidths[i], continued: i < tableHeaders.length - 1 });
    xPos += colWidths[i];
  }
  doc.moveDown(0.3);
  doc.font("Helvetica");

  for (const node of t.dag ?? []) {
    xPos = 50;
    const y = doc.y;
    const cols = [
      node.nodeId ?? "—",
      node.agentId ?? "—",
      node.amountStroops != null ? xlmFromStroops(node.amountStroops) : "—",
      node.txHash ?? "—",
    ];
    for (let i = 0; i < cols.length; i++) {
      doc.text(cols[i], xPos, y, { width: colWidths[i], continued: i < cols.length - 1 });
      xPos += colWidths[i];
    }
    doc.moveDown(0.3);
  }

  // ── Footers (page N of M) ────────────────────────────────────────────────
  const totalPages = doc.bufferedPageRange().count;
  for (let i = 0; i < totalPages; i++) {
    doc.switchToPage(i);
    doc
      .fontSize(8)
      .font("Helvetica")
      .text(
        `ai-net  •  ${t.id}  •  page ${i + 1} of ${totalPages}`,
        50,
        doc.page.height - 40,
        { align: "center", width: doc.page.width - 100 },
      );
  }

  doc.end();
}
