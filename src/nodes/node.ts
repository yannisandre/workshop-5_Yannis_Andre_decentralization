import bodyParser from "body-parser";
import express from "express";
import { BASE_NODE_PORT } from "../config";
import { NodeState, Value } from "../types";

declare global { var nodeData: Record<number, NodeState>; }

type Packet = {
  content: Value | null
  origin: number
  iteration: number
  type: "R" | "P"

}

export async function node(
  nodeId: number, // the ID of the node
  nodeCount: number, // total number of nodes in the network
  faultyCount: number, // number of faulty nodes in the network
  initialValue: Value, // initial value of the node 
  isFaulty: boolean, // true if the node is faulty, false otherwise
  nodesAreReady: () => boolean, // used to know if all nodes are ready to receive requests
  setNodeIsReady: (index: number) => void // this should be called when the node is started and ready to receive requests
) {
  const app = express();
  app.use(express.json());
  app.use(bodyParser.json());

  if (!globalThis.nodeData) {
    globalThis.nodeData = {};
  }

  globalThis.nodeData[nodeId] = {
    killed: false,
    x: isFaulty ? null : initialValue,
    decided: isFaulty ? null : false,
    k: isFaulty ? null : 0,
  };

  // this route allows retrieving the current status of the node
  app.get("/status", (req, res) => {
    res.status(isFaulty ? 500 : 200).send(isFaulty ? "faulty" : "live");
  });

  // get the current state of a node
  app.get("/getState", (req, res) => {
    res.json(globalThis.nodeData[nodeId]).status(200);
  });

  // this route is used to start the consensus algorithm
  app.get("/start", async (req, res) => {
    if (!nodesAreReady()) {
      return res.send("not ready").status(400);
    }
    else {
      consensusProcess();
      return res.send("consencus proessus initialized").status(200);
    }

  });

  const messageStore: Record<number, Record<string, Packet[]>> = {};

  function storePacket(packet: Packet): void {
    const { iteration, type } = packet;
    if (!messageStore[iteration]) messageStore[iteration] = { "R": [], "P": [] };
    if (!messageStore[iteration][type].some(p => p.origin === packet.origin)) {
      messageStore[iteration][type].push(packet);
    }
  }

  function getPackets(iteration: number, phase: "R" | "P"): Packet[] {
    return messageStore[iteration]?.[phase] || [];
  }

  function countPackets(iteration: number, phase: "R" | "P"): number {
    return messageStore[iteration]?.[phase]?.length || 0;
  }

  async function dispatchMessage(type: "R" | "P", iteration: number, content: Value | null) {
    for (let i = 0; i < nodeCount; i++) {
      fetch(`http://localhost:${BASE_NODE_PORT + i}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, origin: nodeId, iteration, content }),
      }).catch(() => {});
    }
  }

  function evaluatePackets(messages: Packet[]): Record<Value, number> {   // to count the amount of each "0" "1" or "?" nodes
    return messages.reduce((acc, { content }) => {
      if (content !== null) acc[content] = (acc[content] || 0) + 1;
      return acc;
    }, { 0: 0, 1: 0, "?": 0 } as Record<Value, number>);
  }

  async function consensusProcess() { // benorconsensus process
    while (!globalThis.nodeData[nodeId].decided) {
      if (globalThis.nodeData[nodeId].killed || isFaulty) return;
      
      globalThis.nodeData[nodeId].k! += 1;
      let value = globalThis.nodeData[nodeId].x!;
      let iteration = globalThis.nodeData[nodeId].k!;
 
      await dispatchMessage("R", iteration, value);
      while (countPackets(iteration, "R") < nodeCount - faultyCount) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const phaseR = getPackets(iteration, "R");
      const majorities = Object.entries(evaluatePackets(phaseR)).filter(([_, count]) => count > nodeCount / 2).map(([key]) => (key === "0" ? 0 : key === "1" ? 1 : "?")) as Value[];
      await dispatchMessage("P", iteration, majorities.length > 0 ? majorities[0] : "?");

      while (countPackets(iteration, "P") < nodeCount - faultyCount) { await new Promise((resolve) => setTimeout(resolve, 10)); }

      const phaseP = getPackets(iteration, "P");
      const validValues = Object.entries(evaluatePackets(phaseP)).filter(([key, count]) => count >= faultyCount + 1 && key !== "?").map(([key]) => (key === "0" ? 0 : 1)) as Value[];
      
      if (validValues.length > 0) {
        globalThis.nodeData[nodeId].x = validValues[0];
        globalThis.nodeData[nodeId].decided = true;
      } 
      else 
      {
        const possibleValues = Object.entries(evaluatePackets(phaseP)).filter(([key, count]) => count >= 1 && key !== "?").map(([key]) => (key === "0" ? 0 : 1)) as Value[];
        globalThis.nodeData[nodeId].x = possibleValues.length > 0 ? possibleValues[0] : Math.random() < 0.5 ? 0 : 1;
      }
    }
  }

  // this route allows the node to receive messages from other nodes
  app.post("/message", (req, res) => {
    if (globalThis.nodeData[nodeId].killed) {
      return res.status(400).send("Node is stopped");
    }

    const { type, origin, iteration, content } = req.body;
    if (!globalThis.nodeData[nodeId].decided) {
      storePacket({ type, origin, iteration, content });
    }
    return res.status(200).send("Message received");
  });

  // this route is used to stop the consensus algorithm
  app.get("/stop", (req, res) => {
    globalThis.nodeData[nodeId].killed = true;
    res.send("terminated").status(200);
  });

  // start the server
  const server = app.listen(BASE_NODE_PORT + nodeId, async () => {
    console.log(`Node ${nodeId} is operational on port ${BASE_NODE_PORT + nodeId}`);
    // the node is ready
    setNodeIsReady(nodeId);
  });

  return server;
}