import { test, expect } from '@playwright/test';
import { WebSocketServer, WebSocket } from 'ws';

test.describe('Task Monitoring', () => {
  let wss: WebSocketServer;
  let activeSocket: WebSocket | null = null;

  test.beforeAll(() => {
    // Start mock WebSocket server on port 3001
    wss = new WebSocketServer({ port: 3001 });
    wss.on('connection', (socket) => {
      activeSocket = socket;
    });
  });

  test.afterAll(async () => {
    // Clean up connections and server
    if (activeSocket) {
      activeSocket.close();
    }
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
  });

  test('asserts DAG node turns green on node_completed event', async ({ page }) => {
    // Navigate to task monitoring page for a mock task
    await page.goto('/tasks/mock-task-e2e-123');

    // Wait for WebSocket connection status chip to show connected
    const statusChip = page.locator('#ws-status');
    await expect(statusChip).toHaveAttribute('data-ws-state', 'connected');

    // Find the research node (it starts as "running")
    const nodeResearch = page.locator('#node-research');
    await expect(nodeResearch).toHaveClass(/running/);
    await expect(nodeResearch).not.toHaveClass(/completed/);

    // Give a short delay to ensure connection is ready, then send the node_completed event
    await page.waitForTimeout(500);

    expect(activeSocket).not.toBeNull();
    activeSocket!.send(JSON.stringify({
      type: 'node_completed',
      nodeId: 'node-research',
      payload: {
        timestamp: new Date().toISOString()
      }
    }));

    // Assert that the node class changes to completed (turns green)
    await expect(nodeResearch).toHaveClass(/completed/);
    
    // Assert that the text content updates to completed
    const nodeStatus = nodeResearch.locator('.node-status');
    await expect(nodeStatus).toHaveText('completed');
  });
});
