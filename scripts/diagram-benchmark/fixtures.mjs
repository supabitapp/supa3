const chain = (count) => ({
  id: `chain-${count}`,
  source: `flowchart TD\n${Array.from({ length: count - 1 }, (_, i) => `N${i} --> N${i + 1}`).join("\n")}`,
  labels: Array.from({ length: count }, (_, i) => `N${i}`),
});

export const fixtures = [
  {
    id: "flow-small",
    source: "flowchart LR\nA[Plan] --> B[Build]\nB --> C[Test]",
    labels: ["Plan", "Build", "Test"],
  },
  {
    id: "decision",
    source:
      "flowchart TD\nA[Request] --> B{Allowed}\nB -->|Yes| C[Execute]\nB -->|No| D[Reject]\nC --> E[Finish]\nD --> E",
    labels: ["Request", "Allowed", "Yes", "No", "Execute", "Reject", "Finish"],
  },
  chain(20),
  chain(30),
  chain(40),
  chain(100),
  {
    id: "dense-64-edges",
    source: `flowchart LR\n${Array.from({ length: 8 }, (_, i) => Array.from({ length: 8 }, (_, j) => `A${i} --> B${j}`).join("\n")).join("\n")}`,
    labels: Array.from({ length: 8 }, (_, i) => [`A${i}`, `B${i}`]).flat(),
  },
  {
    id: "cycle",
    source: "flowchart LR\nA[Receive] --> B[Process]\nB --> C[Retry]\nC --> A\nB --> D[Complete]",
    labels: ["Receive", "Process", "Retry", "Complete"],
  },
  {
    id: "subgraphs",
    source:
      "flowchart TD\nsubgraph Client\n A[Compose] --> B[Send]\nend\nsubgraph Server\n C[Validate] --> D[Persist]\nend\nB --> C",
    labels: ["Client", "Compose", "Send", "Server", "Validate", "Persist"],
  },
  {
    id: "sequence",
    source:
      "sequenceDiagram\nparticipant Client\nparticipant Server\nClient->>Server: Request\nServer-->>Client: Response",
    labels: ["Client", "Server", "Request", "Response"],
  },
  {
    id: "sequence-alt",
    source:
      "sequenceDiagram\nparticipant Client\nparticipant Server\nClient->>Server: Request\nalt Authorized\nServer-->>Client: Success\nelse Denied\nServer-->>Client: Failure\nend",
    labels: ["Client", "Server", "Request", "Authorized", "Success", "Denied", "Failure"],
  },
  {
    id: "class",
    source:
      "classDiagram\nclass Job {\n +String name\n +run()\n}\nclass Queue {\n +enqueue()\n}\nQueue --> Job : schedules",
    labels: ["Job", "Queue", "name", "run", "enqueue", "schedules"],
  },
  {
    id: "er",
    source:
      "erDiagram\nCUSTOMER ||--o{ ORDER : places\nCUSTOMER {\n string name\n}\nORDER {\n int number\n}",
    labels: ["CUSTOMER", "ORDER", "places", "name", "number"],
  },
  {
    id: "state",
    source:
      "stateDiagram-v2\n[*] --> Idle\nIdle --> Working : start\nWorking --> Finished : complete\nFinished --> [*]",
    labels: ["Idle", "Working", "Finished", "start", "complete"],
  },
  {
    id: "unicode",
    source: 'flowchart LR\nA["開始"] --> B["Café"]\nB --> C["完了"]',
    labels: ["開始", "Café", "完了"],
  },
  {
    id: "pie",
    source: 'pie title Allocation\n"Build" : 60\n"Test" : 40',
    labels: ["Allocation", "Build", "Test"],
  },
  {
    id: "malformed",
    source: 'flowchart TD\nA["Unclosed label',
    labels: [],
    expectError: true,
  },
  {
    id: "flow-after-failure",
    source: "flowchart LR\nA[Recovered] --> B[Ready]",
    labels: ["Recovered", "Ready"],
  },
];
